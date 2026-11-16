import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUOTA_UNKNOWN_RESET_HOLD_MS,
  isTerminalIssueStatusForRetry,
  resolveQuotaRetryNotBefore,
} from "../services/run-retry-policy.js";

describe("quota-deferred retry hold (FUL-26246)", () => {
  const now = new Date("2026-11-16T16:11:30.000Z");

  it("(b) holds a provider_quota retry until the parsed reset time", () => {
    const reset = new Date("2026-11-22T15:23:00.000Z");
    expect(resolveQuotaRetryNotBefore({ errorFamily: "provider_quota", retryNotBefore: reset, now })).toEqual(reset);
  });

  it("(b) applies a conservative floor when no reset time was parsed", () => {
    const at = resolveQuotaRetryNotBefore({ errorFamily: "provider_quota", retryNotBefore: null, now });
    expect(at?.getTime()).toBe(now.getTime() + PROVIDER_QUOTA_UNKNOWN_RESET_HOLD_MS);
  });

  it("(b) ignores a stale (past) reset time and still holds", () => {
    const past = new Date(now.getTime() - 60_000);
    const at = resolveQuotaRetryNotBefore({ errorFamily: "provider_quota", retryNotBefore: past, now });
    expect(at!.getTime()).toBeGreaterThan(now.getTime());
  });

  it("(b) leaves non-quota families unchanged", () => {
    expect(resolveQuotaRetryNotBefore({ errorFamily: "transient_upstream", retryNotBefore: null, now })).toBeNull();
  });

  it("(a) treats done and cancelled issues as terminal for retries", () => {
    expect(isTerminalIssueStatusForRetry("cancelled")).toBe(true);
    expect(isTerminalIssueStatusForRetry("done")).toBe(true);
    expect(isTerminalIssueStatusForRetry("todo")).toBe(false);
    expect(isTerminalIssueStatusForRetry("in_progress")).toBe(false);
    expect(isTerminalIssueStatusForRetry(null)).toBe(false);
  });
});
