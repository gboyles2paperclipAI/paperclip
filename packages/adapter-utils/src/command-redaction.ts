export const REDACTED_COMMAND_TEXT_VALUE = "***REDACTED***";

const SECRET_NAME_PATTERN =
  String.raw`[A-Za-z0-9_-]*(?:api[-_]?key|(?:access[-_]?|auth[-_]?)?token|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring|database[-_]?url|db[-_]?url|url)[A-Za-z0-9_-]*`;

const COMMAND_CLI_SECRET_OPTION_RE = new RegExp(
  String.raw`(\B-{1,2}${SECRET_NAME_PATTERN}(?:\s+|=)(["']?))[^\s"'` + "`" + String.raw`]+(\2)`,
  "gi",
);
const COMMAND_ENV_SECRET_ASSIGNMENT_RE = new RegExp(
  String.raw`(\b${SECRET_NAME_PATTERN}\s*=\s*)(?:(["'])([^"'` + "`" + String.raw`\r\n]*)\2|([^\s"'` + "`" + String.raw`]+))`,
  "gi",
);
const COMMAND_AUTHORIZATION_BEARER_RE = /(\bAuthorization\s*:\s*Bearer\s+)[^\s"'`]+/gi;
const COMMAND_SECRET_HTTP_HEADER_RE = new RegExp(
  String.raw`(\b(?:Proxy-Authorization|Authorization|Cookie|Set-Cookie|X-[A-Za-z0-9-]*(?:Api[-_]?Key|Token|Secret))\s*:\s*(?:(?:Bearer|Basic)\s+)?)[^\s"'` + "`" + String.raw`\r\n;]+`,
  "gi",
);
const COMMAND_ENV_SECRET_COLON_RE = new RegExp(
  String.raw`(\b[A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|JWT|BYPASS|DATABASE_URL|DB_URL|URL)\b\s*:\s*(["']?))[^\s"'` + "`" + String.raw`\r\n,;}]+(\2)`,
  "g",
);
const COMMAND_DATABASE_URL_VALUE_RE =
  /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss):\/\/[^\s"'`,;)}\]]+/gi;
const COMMAND_OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const COMMAND_GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g;
const COMMAND_JWT_RE =
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g;
const COMMAND_SECRET_HINTS = [
  "api",
  "key",
  "token",
  "auth",
  "bearer",
  "secret",
  "pass",
  "credential",
  "jwt",
  "private",
  "cookie",
  "connectionstring",
  "database_url",
  "database-url",
  "db_url",
  "db-url",
  "sk-",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
] as const;

function maybeContainsSecretText(command: string) {
  const lower = command.toLowerCase();
  return COMMAND_SECRET_HINTS.some((hint) => lower.includes(hint)) || command.includes(".");
}

export function redactCommandText(command: string, redactedValue = REDACTED_COMMAND_TEXT_VALUE): string {
  const commandWithDatabaseUrlsRedacted = command.replace(COMMAND_DATABASE_URL_VALUE_RE, redactedValue);
  if (commandWithDatabaseUrlsRedacted === command && !maybeContainsSecretText(command)) return command;
  return commandWithDatabaseUrlsRedacted
    .replace(COMMAND_AUTHORIZATION_BEARER_RE, `$1${redactedValue}`)
    .replace(COMMAND_SECRET_HTTP_HEADER_RE, `$1${redactedValue}`)
    .replace(COMMAND_ENV_SECRET_COLON_RE, `$1${redactedValue}$3`)
    .replace(COMMAND_CLI_SECRET_OPTION_RE, `$1${redactedValue}$3`)
    .replace(
      COMMAND_ENV_SECRET_ASSIGNMENT_RE,
      (_match, prefix: string, quote: string | undefined) =>
        quote ? `${prefix}${quote}${redactedValue}${quote}` : `${prefix}${redactedValue}`,
    )
    .replace(COMMAND_OPENAI_KEY_RE, redactedValue)
    .replace(COMMAND_GITHUB_TOKEN_RE, redactedValue)
    .replace(COMMAND_JWT_RE, redactedValue);
}
