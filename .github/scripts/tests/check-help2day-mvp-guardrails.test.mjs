import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUIRED_FIRST_DO_NO_HARM_TERMS,
  REQUIRED_OUT_OF_SCOPE_TERMS,
  REQUIRED_SUPPORT_SCOPE_TERMS,
  checkHelp2dayMvpGuardrails,
} from '../check-help2day-mvp-guardrails.mjs';

const completeRunbookText = [
  ...REQUIRED_SUPPORT_SCOPE_TERMS,
  ...REQUIRED_OUT_OF_SCOPE_TERMS,
  ...REQUIRED_FIRST_DO_NO_HARM_TERMS,
].join('\n');

test('passes when Help2day MVP scope and safety anchors are present', () => {
  const result = checkHelp2dayMvpGuardrails(completeRunbookText);
  assert.deepEqual(result, { passed: true, failures: [] });
});

test('fails when computer-support scope anchors are missing', () => {
  const result = checkHelp2dayMvpGuardrails(
    [
      ...REQUIRED_OUT_OF_SCOPE_TERMS,
      ...REQUIRED_FIRST_DO_NO_HARM_TERMS,
      'generic chatbot',
    ].join('\n')
  );

  assert.equal(result.passed, false);
  assert.match(result.failures.join('\n'), /support scope/);
  assert.match(result.failures.join('\n'), /Computer help, today/);
});

test('fails when first-do-no-harm anchors are missing', () => {
  const result = checkHelp2dayMvpGuardrails(
    [
      ...REQUIRED_SUPPORT_SCOPE_TERMS,
      ...REQUIRED_OUT_OF_SCOPE_TERMS,
      'try a few fixes',
    ].join('\n')
  );

  assert.equal(result.passed, false);
  assert.match(result.failures.join('\n'), /first-do-no-harm rules/);
  assert.match(result.failures.join('\n'), /Never request passwords/);
});
