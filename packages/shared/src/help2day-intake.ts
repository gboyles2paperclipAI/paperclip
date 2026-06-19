export type Help2daySupportCategory = {
  id: string;
  label: string;
  summary: string;
};

export const HELP2DAY_START_CHAT_HEADING = "Start Chat / Get Help";

export const HELP2DAY_SUPPORT_CATEGORIES = [
  {
    id: "windows-help",
    label: "Windows help",
    summary: "Setup, settings, updates, errors, and everyday Windows troubleshooting.",
  },
  {
    id: "macos-basics",
    label: "macOS basics",
    summary: "Basic Mac setup, settings, updates, and common app questions.",
  },
  {
    id: "microsoft-365-outlook",
    label: "Microsoft 365 / Outlook",
    summary: "Microsoft 365 apps, Outlook setup, mail flow, calendars, and account basics.",
  },
  {
    id: "email-troubleshooting",
    label: "Email setup/troubleshooting",
    summary: "Mailbox setup, sending or receiving issues, filters, and common client settings.",
  },
  {
    id: "browser-issues",
    label: "Browser issues",
    summary: "Chrome, Edge, Safari, Firefox, extensions, downloads, tabs, and site problems.",
  },
  {
    id: "printer-issues",
    label: "Printer issues",
    summary: "Printer setup, queues, drivers, Wi-Fi printers, scanning, and stuck jobs.",
  },
  {
    id: "wifi-home-networking",
    label: "Wi-Fi / home networking basics",
    summary: "Basic connectivity, router restarts, weak signal, device joins, and simple checks.",
  },
  {
    id: "slow-computer",
    label: "Slow computer",
    summary: "Startup slowness, storage pressure, updates, resource use, and safe cleanup.",
  },
  {
    id: "backup-help",
    label: "Backup help",
    summary: "Backup setup, restore checks, cloud sync basics, and safer change preparation.",
  },
  {
    id: "password-mfa-guidance",
    label: "Password/MFA guidance",
    summary: "Safe account recovery steps, password manager basics, and MFA troubleshooting.",
  },
  {
    id: "malware-compromise-triage",
    label: "Malware or compromise concern triage",
    summary: "Read-only triage for suspected malware, account compromise, ransomware, or fraud.",
  },
  {
    id: "small-business-workstation",
    label: "Small-business workstation help",
    summary: "Workstation setup, user basics, printers, email, browsers, and common office tools.",
  },
  {
    id: "service-pricing-policy",
    label: "Help2day service/pricing/policy questions",
    summary: "Questions about what Help2day supports, pricing, service limits, and policies.",
  },
  {
    id: "other-computer-issue",
    label: "Other computer issue",
    summary: "A fallback for computer-support issues that do not match another category.",
  },
] as const satisfies readonly Help2daySupportCategory[];

export const HELP2DAY_SECRET_SHARING_WARNING =
  "Do not share passwords, MFA codes, recovery keys, private keys, or payment card numbers.";

export const HELP2DAY_IN_SCOPE_COPY =
  "Help2day is for computer support and Help2day service questions. Start with the category that best matches your computer issue.";

export const HELP2DAY_OUT_OF_SCOPE_COPY =
  "Help2day cannot help with homework or math, politics, creative writing, legal, medical, or financial advice, credential theft, password cracking, security bypass, malware or exploit guidance, software piracy, or anything unrelated to computer support or Help2day services.";

export const HELP2DAY_FIRST_DO_NO_HARM_COPY =
  "We start with observation and read-only checks, prefer reversible low-risk steps, ask for backup or restore-point preparation before risky changes, make one small change at a time, and test after each change.";
