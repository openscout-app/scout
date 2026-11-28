/**
 * Secrets out of commands before they reach the decision record: tokens in
 * assignments and flags, Authorization headers, provider key shapes, and
 * credentials in URLs. It keeps the command's shape so the record still says
 * what ran.
 */
const REDACTED = "[redacted]";

const RULES: Array<[RegExp, string]> = [
  // URL credentials: https://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:'"]+:[^\s/@'"]+@/gi, `$1${REDACTED}@`],
  // Authorization and similar headers, to the end of the quoted value or line.
  [/\b((?:proxy-)?authorization|x-api-key|api-key|x-auth-token|cookie)(\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?[^\s'"\n]+(?:\s+[^\s'"\n-][^\s'"\n]*)?/gi, `$1$2${REDACTED}`],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // NAME_TOKEN=value, export API_KEY=value, --password=value
  [/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PASS|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?|SESSION)[A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|\S+)/gi, `$1=${REDACTED}`],
  [/(--?(?:token|password|passwd|secret|api-key|apikey|auth|key|access-token)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s-]\S*)/gi, `$1${REDACTED}`],
  // mysql/mariadb's glued password: `mysql -pSuperSecret1`.
  [/\b((?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlshow|mariadb|mariadb-dump)\b[^|;&\n]*?\s-p)(?!assword)(?:"[^"]*"|'[^']*'|[^\s"']+)/gi, `$1${REDACTED}`],
  // user:pass after -u / --user (curl, wget, httpie): keep the user.
  [/((?:^|\s)(?:-u|--user|--proxy-user|--http-user)(?:=|\s*))(["']?)([^\s:"']+):([^\s"']+)\2/g, `$1$2$3:${REDACTED}$2`],
  // A secret-named word and the value after it: `aws configure set aws_secret_access_key VALUE`.
  // The word is an identifier with a separator (`client_secret`, `db.password`) or all caps
  // (`DB_PASSWORD`), so prose such as "touches a secret" is left alone.
  [/\b((?:[a-z0-9]+[_.-])+(?:secret|password|passwd|token|api[_-]?key|access[_-]?key|private[_-]?key)(?:[_.-][a-z0-9]+)*|(?:secret|password|passwd|token|api[_-]?key|access[_-]?key|private[_-]?key)(?:[_.-][a-z0-9]+)+|[A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY)[A-Z0-9_]*)(\s+)(?!\[redacted\])("[^"]*"|'[^']*'|[^\s"'-][^\s"']*)/g, `$1$2${REDACTED}`],
  // Provider key shapes.
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/g, REDACTED],
  [/\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b(?:xox[abprs]|xapp)-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, REDACTED],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
];

export function redactSecrets(text: string): string;
export function redactSecrets(text: string | null | undefined): string | null | undefined;
export function redactSecrets(text: string | null | undefined): string | null | undefined {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}
