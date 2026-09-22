// A reader for the Python literals ScubaGoggles keeps its policy tables in.
//
// The tables (_expectedPolicySettings, _defaults, ACTIVE_RULE_DEFAULTS) are
// plain data, but they live in .py source, so they have to be read out rather
// than imported. This handles what those literals actually use: dicts, lists,
// tuples, strings with implicit concatenation, True/False/None, numbers, and
// bare identifiers (lambdas and class names, kept as their names).
//
// It is deliberately strict. Anything it does not recognise raises, because a
// table that parses "nearly right" would change assessment results silently.

/** A bare Python name, kept so the caller can map it to something meaningful. */
export class PyName {
  constructor(name) {
    this.name = name;
  }
}

class Reader {
  constructor(source, offset = 0) {
    this.source = source;
    this.pos = offset;
  }

  error(message) {
    const line = this.source.slice(0, this.pos).split("\n").length;
    return new Error(`python literal: ${message} at line ${line}`);
  }

  skipTrivia() {
    for (;;) {
      const ch = this.source[this.pos];
      if (ch === undefined) return;
      if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === "\\") {
        this.pos += 1;
        continue;
      }
      if (ch === "#") {
        const end = this.source.indexOf("\n", this.pos);
        this.pos = end === -1 ? this.source.length : end;
        continue;
      }
      return;
    }
  }

  peek() {
    this.skipTrivia();
    return this.source[this.pos];
  }

  expect(ch) {
    if (this.peek() !== ch) throw this.error(`expected ${ch}, found ${this.peek() ?? "end of input"}`);
    this.pos += 1;
  }

  /** Read one value. Adjacent string literals are concatenated, as Python does. */
  readValue() {
    const ch = this.peek();
    if (ch === undefined) throw this.error("unexpected end of input");
    if (ch === "{") return this.readBraced();
    if (ch === "[") return this.readSequence("[", "]");
    if (ch === "(") return this.readSequence("(", ")");
    if (ch === '"' || ch === "'" || /[rfbu]/i.test(ch)) {
      const string = this.tryReadString();
      if (string !== null) return string;
    }
    if (/[-\d]/.test(ch)) return this.readNumber();
    return this.readName();
  }

  /** `{}` is a dict in these tables; sets do not appear in them. */
  readBraced() {
    this.expect("{");
    const out = {};
    if (this.peek() === "}") {
      this.pos += 1;
      return out;
    }
    for (;;) {
      const key = this.readValue();
      if (typeof key !== "string") throw this.error("dict keys must be strings");
      this.expect(":");
      out[key] = this.readValue();
      const next = this.peek();
      if (next === ",") {
        this.pos += 1;
        if (this.peek() === "}") { this.pos += 1; return out; }
        continue;
      }
      if (next === "}") { this.pos += 1; return out; }
      throw this.error(`expected , or } in dict, found ${next ?? "end of input"}`);
    }
  }

  readSequence(open, close) {
    this.expect(open);
    const out = [];
    if (this.peek() === close) { this.pos += 1; return out; }
    for (;;) {
      out.push(this.readValue());
      const next = this.peek();
      if (next === ",") {
        this.pos += 1;
        if (this.peek() === close) { this.pos += 1; return out; }
        continue;
      }
      if (next === close) { this.pos += 1; return out; }
      throw this.error(`expected , or ${close}, found ${next ?? "end of input"}`);
    }
  }

  /** Returns the concatenated string, or null if the position is not a string. */
  tryReadString() {
    let value = null;
    for (;;) {
      const start = this.pos;
      this.skipTrivia();
      const prefix = /^[rfbu]{0,2}/i.exec(this.source.slice(this.pos))[0];
      const quote = this.source[this.pos + prefix.length];
      if (quote !== '"' && quote !== "'") {
        this.pos = start;
        return value;
      }
      const raw = prefix.toLowerCase().includes("r");
      this.pos += prefix.length + 1;
      value = (value ?? "") + this.readStringBody(quote, raw);
    }
  }

  readStringBody(quote, raw) {
    let out = "";
    for (;;) {
      const ch = this.source[this.pos];
      if (ch === undefined) throw this.error("unterminated string");
      this.pos += 1;
      if (ch === quote) return out;
      if (ch !== "\\") { out += ch; continue; }

      const escaped = this.source[this.pos];
      this.pos += 1;
      if (raw) { out += "\\" + escaped; continue; }
      const simple = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', "0": "\0" };
      if (escaped in simple) { out += simple[escaped]; continue; }
      if (escaped === "\n") continue; // line continuation
      out += escaped;
    }
  }

  readNumber() {
    const match = /^-?\d+(?:\.\d+)?/.exec(this.source.slice(this.pos));
    if (!match) throw this.error("malformed number");
    this.pos += match[0].length;
    return Number(match[0]);
  }

  readName() {
    const match = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(this.source.slice(this.pos));
    if (!match) throw this.error(`unrecognised token ${JSON.stringify(this.source.slice(this.pos, this.pos + 20))}`);
    this.pos += match[0].length;
    const name = match[0];
    if (name === "True") return true;
    if (name === "False") return false;
    if (name === "None") return null;
    // The tables use lambdas only as value validators, which this port does
    // not need, so the body is skipped rather than interpreted.
    if (name === "lambda") {
      this.skipToExpressionEnd();
      return new PyName("lambda");
    }
    return new PyName(name);
  }

  /** Skip to the comma or closing brace that ends the current expression. */
  skipToExpressionEnd() {
    let depth = 0;
    for (; this.pos < this.source.length; this.pos += 1) {
      const ch = this.source[this.pos];
      if (ch === "(" || ch === "[" || ch === "{") depth += 1;
      else if (ch === ")" || ch === "]") depth -= 1;
      else if (ch === "}") { if (depth === 0) return; depth -= 1; }
      else if (ch === "," && depth === 0) return;
      else if (ch === "'" || ch === '"') { this.pos += 1; this.readStringBody(ch, false); this.pos -= 1; }
      else if (ch === "#") { const end = this.source.indexOf("\n", this.pos); this.pos = end === -1 ? this.source.length : end; }
    }
  }
}

/**
 * Read the literal assigned to `name` in `source`, e.g. `_defaults = {...}`.
 * With `update`, reads the argument of `name.update({...})` instead.
 */
export function readAssignment(source, name, { update = false } = {}) {
  const pattern = update
    ? new RegExp(`^\\s*${escape(name)}\\.update\\(`, "m")
    : new RegExp(`^\\s*${escape(name)}\\s*=\\s*(?=[{[])`, "m");
  const match = pattern.exec(source);
  if (!match) throw new Error(`python literal: no assignment to ${name}${update ? ".update(...)" : ""} found`);
  return new Reader(source, match.index + match[0].length).readValue();
}

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
