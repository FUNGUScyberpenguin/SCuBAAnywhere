import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { checkTarget } from "./allowlist.js";

/**
 * A stateless forwarder for the Microsoft admin APIs that refuse browser
 * origins.
 *
 * What it does: check the destination against the allowlist, pass the request
 * on with the caller's own bearer token, return the response.
 *
 * What it deliberately does not do: keep anything. No disk writes, no cache, no
 * request or response bodies in the log, no tokens in the log. Tenant
 * configuration passes through this process and is gone when the response ends.
 */

export interface RelayConfig {
  /** Browser origin allowed to call the relay. Required; there is no wildcard. */
  allowedOrigin: string;
  port: number;
  /** Refuse request bodies larger than this. */
  maxBodyBytes: number;
  requestTimeoutMs: number;
}

export function configFromEnvironment(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const allowedOrigin = env["SCUBA_RELAY_ORIGIN"];
  if (!allowedOrigin) {
    throw new Error(
      "SCUBA_RELAY_ORIGIN is required: set it to the origin the web app is served from, " +
        "for example https://scuba.example.gov. The relay does not accept a wildcard.",
    );
  }
  return {
    allowedOrigin,
    port: Number(env["PORT"] ?? 8787),
    maxBodyBytes: Number(env["SCUBA_RELAY_MAX_BODY"] ?? 1_000_000),
    requestTimeoutMs: Number(env["SCUBA_RELAY_TIMEOUT_MS"] ?? 120_000),
  };
}

/** Headers passed upstream. Everything else, including cookies, is dropped. */
const FORWARD_REQUEST_HEADERS = [
  "authorization", "content-type", "accept", "prefer", "x-responseformat", "consistencylevel",
];

/** Headers returned to the browser. Set-Cookie is never among them. */
const FORWARD_RESPONSE_HEADERS = ["content-type", "retry-after"];

export function createRelay(config: RelayConfig) {
  return createServer((req, res) => {
    handle(req, res, config).catch((error) => {
      // The message may name an upstream host but never a body or a token.
      respond(res, 502, { error: "upstream request failed", detail: String(error instanceof Error ? error.message : error) }, config);
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, config: RelayConfig): Promise<void> {
  const url = new URL(req.url ?? "/", "http://relay.invalid");

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(config));
    res.end();
    return;
  }

  if (url.pathname === "/healthz") {
    respond(res, 200, { status: "ok" }, config);
    return;
  }

  if (url.pathname !== "/v1/forward") {
    respond(res, 404, { error: "not found" }, config);
    return;
  }

  const origin = req.headers["origin"];
  if (origin && origin !== config.allowedOrigin) {
    respond(res, 403, { error: "origin is not allowed" }, config);
    return;
  }

  const target = url.searchParams.get("target");
  if (!target) {
    respond(res, 400, { error: "missing target" }, config);
    return;
  }

  const decision = checkTarget(target);
  if (!decision.allowed) {
    respond(res, 403, { error: "target refused", detail: decision.reason }, config);
    return;
  }

  let body: Buffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > config.maxBodyBytes) {
      rejectOversizeBody(req, res, config);
      return;
    }
    try {
      body = await readBody(req, config.maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        rejectOversizeBody(req, res, config);
        return;
      }
      throw error;
    }
  }

  const headers: Record<string, string> = {};
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  headers["user-agent"] = "SCuBAAnywhere-relay";

  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const upstream = await fetch(target, {
      method: req.method ?? "GET",
      headers,
      ...(body ? { body } : {}),
      signal: controller.signal,
      redirect: "manual",
    });

    const outHeaders: Record<string, string> = corsHeaders(config);
    for (const name of FORWARD_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) outHeaders[name] = value;
    }
    outHeaders["Cache-Control"] = "no-store";

    const payload = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, outHeaders);
    res.end(payload);
    logRequest(req.method ?? "GET", target, upstream.status, Date.now() - started);
  } finally {
    clearTimeout(timeout);
  }
}

/** Host and path only. No query string, no headers, no bodies. */
function logRequest(method: string, target: string, status: number, ms: number): void {
  let where = "<unparsed>";
  try {
    const url = new URL(target);
    where = `${url.host}${url.pathname}`;
  } catch { /* logged as unparsed */ }
  process.stdout.write(`${method} ${where} -> ${status} ${ms}ms\n`);
}

function corsHeaders(config: RelayConfig): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": config.allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": FORWARD_REQUEST_HEADERS.join(", "),
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function respond(res: ServerResponse, status: number, payload: unknown, config: RelayConfig): void {
  res.writeHead(status, { ...corsHeaders(config), "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // Stop reading, but leave the socket open long enough to answer. A
        // destroyed socket reaches the browser as a network error with no
        // explanation of what went wrong.
        req.pause();
        reject(new BodyTooLarge(`request body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Answer 413, then close the connection rather than draining the rest. */
function rejectOversizeBody(req: IncomingMessage, res: ServerResponse, config: RelayConfig): void {
  res.setHeader("Connection", "close");
  respond(res, 413, { error: `request body exceeds ${config.maxBodyBytes} bytes` }, config);
  res.on("finish", () => req.destroy());
}

// Only start a server when run directly, so the tests can import the module.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const config = configFromEnvironment();
  createRelay(config).listen(config.port, () => {
    process.stdout.write(
      `SCuBAAnywhere relay on :${config.port}, forwarding for ${config.allowedOrigin}\n`,
    );
  });
}
