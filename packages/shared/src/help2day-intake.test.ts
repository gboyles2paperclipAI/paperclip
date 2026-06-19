import { describe, expect, it } from "vitest";
import {
  HELP2DAY_FIRST_DO_NO_HARM_COPY,
  HELP2DAY_OUT_OF_SCOPE_COPY,
  HELP2DAY_SECRET_SHARING_WARNING,
  HELP2DAY_START_CHAT_HEADING,
  HELP2DAY_SUPPORT_CATEGORIES,
} from "./help2day-intake.js";

describe("Help2day Start Chat intake copy", () => {
  it("keeps the MVP computer-support categories available", () => {
    expect(HELP2DAY_START_CHAT_HEADING).toBe("Start Chat / Get Help");
    expect(HELP2DAY_SUPPORT_CATEGORIES.map(category => category.label)).toEqual([
      "Windows help",
      "macOS basics",
      "Microsoft 365 / Outlook",
      "Email setup/troubleshooting",
      "Browser issues",
      "Printer issues",
      "Wi-Fi / home networking basics",
      "Slow computer",
      "Backup help",
      "Password/MFA guidance",
      "Malware or compromise concern triage",
      "Small-business workstation help",
      "Help2day service/pricing/policy questions",
      "Other computer issue",
    ]);
  });

  it("keeps the user-facing secret warning explicit", () => {
    expect(HELP2DAY_SECRET_SHARING_WARNING).toContain("Do not share passwords");
    expect(HELP2DAY_SECRET_SHARING_WARNING).toContain("MFA codes");
    expect(HELP2DAY_SECRET_SHARING_WARNING).toContain("recovery keys");
    expect(HELP2DAY_SECRET_SHARING_WARNING).toContain("private keys");
    expect(HELP2DAY_SECRET_SHARING_WARNING).toContain("payment card numbers");
  });

  it("keeps out-of-scope and first-do-no-harm boundaries visible", () => {
    expect(HELP2DAY_OUT_OF_SCOPE_COPY).toContain("credential theft");
    expect(HELP2DAY_OUT_OF_SCOPE_COPY).toContain("password cracking");
    expect(HELP2DAY_OUT_OF_SCOPE_COPY).toContain("malware or exploit guidance");
    expect(HELP2DAY_OUT_OF_SCOPE_COPY).toContain("unrelated to computer support");
    expect(HELP2DAY_FIRST_DO_NO_HARM_COPY).toContain("observation and read-only checks");
    expect(HELP2DAY_FIRST_DO_NO_HARM_COPY).toContain("one small change at a time");
    expect(HELP2DAY_FIRST_DO_NO_HARM_COPY).toContain("test after each change");
  });
});
