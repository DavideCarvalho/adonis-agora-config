/**
 * Whether a token holding `granted` may do `required`. Mirrors the Agora-wide capability rule:
 * both sides are split on `:` and compared segment by segment; a granted `*` segment matches
 * exactly one segment, and a granted capability ending in a `*` segment also matches any number
 * of further segments. So `*` matches everything, `config:*` matches `config:read` and
 * `config:secrets:read`, and `config:secrets:*` matches `config:secrets:read`. Otherwise the
 * shapes must be equal: nothing is implied (`config:read` never grants `config:secrets:read`), and
 * empty or non-string grants are ignored.
 */
export function capabilityAllows(granted: readonly string[], required: string): boolean {
  const want = required.split(':');
  for (const capability of granted) {
    if (typeof capability !== 'string' || capability === '') continue;
    const have = capability.split(':');
    let matched = true;
    for (let index = 0; index < have.length; index += 1) {
      const segment = have[index];
      if (index >= want.length) {
        // Past the end of `required`: only a trailing `*` (which covers ≥1 segment) got here.
        matched = false;
        break;
      }
      if (segment === '*') continue;
      if (segment !== want[index]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    // A trailing `*` covers the rest; otherwise the shapes must have the same length.
    if (have.length === want.length || have[have.length - 1] === '*') return true;
  }
  return false;
}
