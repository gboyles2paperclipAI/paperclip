import { redactSensitiveText, sanitizeRecord } from "../redaction.js";

export type OutputEgressSurface =
  | "run_log"
  | "workspace_operation_log"
  | "issue_comment"
  | "issue_document"
  | "work_product"
  | "plugin_activity";

export interface OutputEgressGuardResult {
  action: "allow" | "quarantine";
  content: string;
  reason: "redacted" | "env_dump" | "process_dump" | "config_dump" | null;
  summary: {
    surface: OutputEgressSurface;
    lines: number;
    assignmentLines: number;
    sensitiveKeyLines: number;
  };
}

const ASSIGNMENT_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const JSONISH_SECRET_FIELD_RE =
  /["']?(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring|database[-_]?url)["']?\s*[:=]/i;
const SENSITIVE_KEY_RE =
  /(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring|database[-_]?url|dsn)/i;
const PROCESS_DUMP_RE =
  /\b(?:ExecStart=|Environment=|\/proc\/\d+\/(?:cmdline|environ)|ps\s+(?:aux|ef)|systemctl\s+(?:status|show|cat))\b/i;
const CONFIG_DUMP_RE =
  /\b(?:BEGIN [A-Z ]*PRIVATE KEY|DATABASE_URL=|postgres(?:ql)?:\/\/|mysql:\/\/|mongodb(?:\+srv)?:\/\/|redis:\/\/|amqp:\/\/|kafka:\/\/|nats:\/\/)\b/i;

function summarizeLines(input: string) {
  const lines = input.split(/\r?\n/).filter((line) => line.length > 0);
  let assignmentLines = 0;
  let sensitiveKeyLines = 0;

  for (const line of lines) {
    const assignment = ASSIGNMENT_LINE_RE.exec(line);
    if (assignment) {
      assignmentLines += 1;
      if (SENSITIVE_KEY_RE.test(assignment[1] ?? "")) sensitiveKeyLines += 1;
      continue;
    }
    if (JSONISH_SECRET_FIELD_RE.test(line)) sensitiveKeyLines += 1;
  }

  return { lines: lines.length, assignmentLines, sensitiveKeyLines };
}

function classifyHighRiskDump(input: string, summary: ReturnType<typeof summarizeLines>) {
  if (summary.assignmentLines >= 8 && summary.assignmentLines >= Math.max(4, Math.floor(summary.lines * 0.5))) {
    return "env_dump" as const;
  }
  if (PROCESS_DUMP_RE.test(input)) return "process_dump" as const;
  if (CONFIG_DUMP_RE.test(input) && summary.sensitiveKeyLines > 0) return "config_dump" as const;
  return null;
}

function buildQuarantineSummary(
  surface: OutputEgressSurface,
  reason: NonNullable<OutputEgressGuardResult["reason"]>,
  summary: OutputEgressGuardResult["summary"],
) {
  return [
    "[paperclip output egress guard]",
    `surface=${surface}`,
    "action=quarantined",
    `reason=${reason}`,
    `lines=${summary.lines}`,
    `assignmentLines=${summary.assignmentLines}`,
    `sensitiveKeyLines=${summary.sensitiveKeyLines}`,
  ].join(" ");
}

export function guardTextForPersistence(
  input: string,
  options: { surface: OutputEgressSurface },
): OutputEgressGuardResult {
  const summary = { surface: options.surface, ...summarizeLines(input) };
  const dumpReason = classifyHighRiskDump(input, summary);
  if (dumpReason) {
    return {
      action: "quarantine",
      content: buildQuarantineSummary(options.surface, dumpReason, summary),
      reason: dumpReason,
      summary,
    };
  }

  const content = redactSensitiveText(input);
  return {
    action: "allow",
    content,
    reason: content === input ? null : "redacted",
    summary,
  };
}

export function guardValueForPersistence<T>(
  value: T,
  options: { surface: OutputEgressSurface },
): T {
  if (typeof value === "string") {
    return guardTextForPersistence(value, options).content as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => guardValueForPersistence(entry, options)) as T;
  }
  if (!value || typeof value !== "object") return value;

  const sanitized = sanitizeRecord(value as Record<string, unknown>);
  const guarded: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(sanitized)) {
    guarded[key] = guardValueForPersistence(entry, options);
  }
  return guarded as T;
}
