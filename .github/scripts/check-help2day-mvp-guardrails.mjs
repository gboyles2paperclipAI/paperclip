#!/usr/bin/env node
/**
 * Verifies that the Help2day website restart runbook keeps the MVP support
 * scope and first-do-no-harm safety anchors visible before PR review.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_RUNBOOK_PATH = 'docs/deploy/help2day-dedicated-ops.md';

export const REQUIRED_SUPPORT_SCOPE_TERMS = [
  'Computer help, today',
  'not a general-purpose chatbot',
  'Windows help',
  'macOS basics',
  'Microsoft 365',
  'Outlook',
  'email setup',
  'browsers',
  'printers',
  'Wi-Fi',
  'slow computers',
  'backups',
  'safe password',
  'MFA',
  'malware or compromise',
  'small-business workstation',
  'service, pricing, and policy',
];

export const REQUIRED_OUT_OF_SCOPE_TERMS = [
  'homework',
  'math',
  'politics',
  'creative writing',
  'legal advice',
  'medical advice',
  'financial advice',
  'credential theft',
  'password cracking',
  'security bypass',
  'malware or exploit guidance',
  'software piracy',
  'unrelated to computer support',
];

export const REQUIRED_FIRST_DO_NO_HARM_TERMS = [
  'First-do-no-harm',
  'observation and read-only checks',
  'reversible, low-risk troubleshooting',
  'backup, restore point, export, or current-state documentation',
  'one small change at a time',
  'Test after each change',
  'Record what changed',
  'Never request passwords',
  'MFA codes',
  'recovery keys',
  'seed phrases',
  'private keys',
  'full payment card data',
  'unnecessary sensitive files',
  'Escalate suspected compromise',
  'fraud',
  'stalking or spyware',
  'business email compromise',
  'malware or ransomware',
  'data loss',
];

function normalize(value) {
  return value.toLowerCase().replace(/\s+/g, ' ');
}

function missingTerms(text, requiredTerms) {
  const normalizedText = normalize(text);
  return requiredTerms.filter(term => !normalizedText.includes(normalize(term)));
}

export function checkHelp2dayMvpGuardrails(text) {
  const failures = [];
  const groups = [
    ['support scope', REQUIRED_SUPPORT_SCOPE_TERMS],
    ['out-of-scope boundaries', REQUIRED_OUT_OF_SCOPE_TERMS],
    ['first-do-no-harm rules', REQUIRED_FIRST_DO_NO_HARM_TERMS],
  ];

  for (const [label, terms] of groups) {
    const missing = missingTerms(text, terms);
    if (missing.length > 0) {
      failures.push(`${label} missing required anchors: ${missing.join(', ')}`);
    }
  }

  return { passed: failures.length === 0, failures };
}

function main() {
  const path = process.argv[2] ?? DEFAULT_RUNBOOK_PATH;
  const text = fs.readFileSync(path, 'utf8');
  const result = checkHelp2dayMvpGuardrails(text);

  if (!result.passed) {
    for (const failure of result.failures) {
      console.error(failure);
    }
  }

  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
