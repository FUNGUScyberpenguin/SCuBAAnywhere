/**
 * Rego built-ins the OPA WebAssembly runtime hands back to the host.
 *
 * OPA compiles most built-ins into the module, but a handful are left for the
 * SDK to implement. `@open-policy-agent/opa-wasm` does not ship these two, and
 * CISA's baselines use both, so evaluation fails without them:
 *
 *   indexof_n     Gmail.rego, EXOConfig.rego (DNS record parsing)
 *   regex.find_n  DefenderConfig.rego, SecuritySuiteConfig.rego
 *
 * Go's regexp is RE2 and JavaScript's is backtracking, so the two engines are
 * not identical. The patterns CISA uses are plain character classes and
 * literals, which both engines read the same way. Check any new pattern before
 * assuming that holds.
 */
export type BuiltinMap = Record<string, (...args: never[]) => unknown>;

/** All byte offsets at which `needle` occurs in `haystack`. */
function indexofN(haystack: string, needle: string): number[] {
  const offsets: number[] = [];
  if (needle === "") return offsets;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    offsets.push(i);
  }
  return offsets;
}

/** The first `n` matches of `pattern` in `value`; `n < 0` means all of them. */
function regexFindN(pattern: string, value: string, n: number): string[] {
  const matches: string[] = [];
  if (n === 0) return matches;
  const re = new RegExp(pattern, "g");
  for (const match of value.matchAll(re)) {
    matches.push(match[0]);
    if (n > 0 && matches.length >= n) break;
    if (match[0] === "") re.lastIndex += 1;
  }
  return matches;
}

export const REGO_BUILTINS: BuiltinMap = {
  indexof_n: indexofN as (...args: never[]) => unknown,
  "regex.find_n": regexFindN as (...args: never[]) => unknown,
};
