const fields = new Set(['session_id', 'status', 'consent', 'id', 'sequence', 'text', 'start_ms', 'end_ms', 'source']);
const codes = new Set([
  'invalid_type', 'invalid_format', 'invalid_value', 'unrecognized_keys',
  'too_small', 'too_big', 'invalid_union', 'custom',
]);

// Zod issues can contain submitted values, messages and unknown object keys. Only
// fixed schema field names and fixed issue codes may leave the validation boundary.
export function validationMessage(issues: readonly { path: readonly PropertyKey[]; code: string }[]): string {
  const reasons = new Set<string>();
  for (const issue of issues.slice(0, 6)) {
    const key = issue.path.length === 1 ? issue.path[0] : undefined;
    const field = typeof key === 'string' && fields.has(key) ? key : 'body';
    const code = codes.has(issue.code) ? issue.code : 'invalid';
    reasons.add(`${field}: ${code}`);
  }
  return `Request fields are invalid${reasons.size ? ` (${[...reasons].join('; ')})` : ''}`;
}
