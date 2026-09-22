import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { configFromEnvironment, createRelay, type RelayConfig } from "../src/server.js";

const ORIGIN = "https://scuba.example.gov";
const config: RelayConfig = {
  allowedOrigin: ORIGIN,
  port: 0,
  maxBodyBytes: 1000,
  requestTimeoutMs: 5000,
};

let baseUrl = "";
const server = createRelay(config);

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));

const forward = (target: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}/v1/forward?target=${encodeURIComponent(target)}`, {
    headers: { Origin: ORIGIN, ...(init.headers ?? {}) },
    ...init,
  });

describe("configFromEnvironment", () => {
  it("refuses to start without an allowed origin", () => {
    expect(() => configFromEnvironment({})).toThrow(/SCUBA_RELAY_ORIGIN is required/);
  });

  it("reads the origin and port", () => {
    const parsed = configFromEnvironment({ SCUBA_RELAY_ORIGIN: ORIGIN, PORT: "9000" });
    expect(parsed.allowedOrigin).toBe(ORIGIN);
    expect(parsed.port).toBe(9000);
  });
});

describe("relay", () => {
  it("answers a health check", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("refuses a target that is not on the allowlist", async () => {
    const response = await forward("https://evil.example/adminapi/x");
    expect(response.status).toBe(403);
    expect((await response.json()).detail).toMatch(/allowlist/);
  });

  it("refuses a request from another origin", async () => {
    const response = await forward("https://outlook.office365.com/adminapi/beta/t/InvokeCommand", {
      headers: { Origin: "https://somewhere.else" },
    });
    expect(response.status).toBe(403);
  });

  it("answers a preflight with the configured origin only", async () => {
    const response = await fetch(`${baseUrl}/v1/forward`, { method: "OPTIONS", headers: { Origin: ORIGIN } });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("returns 404 for any other path", async () => {
    expect((await fetch(`${baseUrl}/`)).status).toBe(404);
  });

  it("forwards the bearer token and returns the upstream body", async () => {
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ value: [{ Name: "Default" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    try {
      const response = await realFetch(
        `${baseUrl}/v1/forward?target=${encodeURIComponent("https://outlook.office365.com/adminapi/beta/t/InvokeCommand")}`,
        {
          method: "POST",
          headers: { Origin: ORIGIN, Authorization: "Bearer token-abc", "Content-Type": "application/json" },
          body: JSON.stringify({ CmdletInput: { CmdletName: "Get-OrganizationConfig" } }),
        },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ value: [{ Name: "Default" }] });

      const [, init] = upstream.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer token-abc");
      // Cookies must never reach an admin API through the relay.
      expect(Object.keys(init.headers as Record<string, string>)).not.toContain("cookie");
    } finally {
      upstream.mockRestore();
    }
  });

  it("rejects a body larger than the limit", async () => {
    const response = await forward("https://outlook.office365.com/adminapi/beta/t/InvokeCommand", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: "x".repeat(2000),
    });
    expect(response.status).toBe(413);
  });
});

// The forwarding test stubs global fetch, so the client call needs the real one.
const realFetch = globalThis.fetch.bind(globalThis);
