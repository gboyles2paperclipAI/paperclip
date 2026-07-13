const DEPLOYMENT_MODES = new Set(["local_trusted", "authenticated"]);
const JSON_CONTENT_TYPE_RE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i;
export const PAPERCLIP_REQUEST_TIMEOUT_MS = 300_000;

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function deploymentModeFromHealth(health) {
  const mode = nonEmpty(health?.deploymentMode);
  if (!mode || !DEPLOYMENT_MODES.has(mode)) {
    throw new Error("Paperclip health returned an unsupported deployment mode");
  }
  return mode;
}

export function paperclipRequestUrl(apiUrl, requestUrl) {
  const base = new URL(apiUrl);
  if ((base.protocol !== "http:" && base.protocol !== "https:") || base.username || base.password) {
    throw new Error("PAPERCLIP_API_URL must be an HTTP(S) URL without embedded credentials");
  }

  const request = new URL(requestUrl, base);
  if (request.protocol !== "http:" && request.protocol !== "https:") {
    throw new Error("Paperclip API requests must use HTTP(S)");
  }
  if (request.username || request.password || request.origin !== base.origin) {
    throw new Error("Refusing to send Paperclip API credentials to a different origin");
  }
  return request;
}

export async function fetchPaperclipJson({
  apiUrl,
  requestUrl,
  headers = { Accept: "application/json" },
  fetchOptions = {},
  fetchImpl = fetch,
  timeoutMs = PAPERCLIP_REQUEST_TIMEOUT_MS,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > PAPERCLIP_REQUEST_TIMEOUT_MS) {
    throw new Error(`Paperclip request timeout must be between 1 and ${PAPERCLIP_REQUEST_TIMEOUT_MS} milliseconds`);
  }
  const url = paperclipRequestUrl(apiUrl, requestUrl);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = fetchOptions.signal
    ? AbortSignal.any([fetchOptions.signal, timeoutSignal])
    : timeoutSignal;
  const response = await fetchImpl(url, {
    ...fetchOptions,
    headers,
    redirect: "error",
    signal,
  });

  if (!nonEmpty(response.url)) {
    throw new Error("Paperclip API response did not expose a final URL");
  }
  const finalUrl = paperclipRequestUrl(apiUrl, response.url);
  if (finalUrl.origin !== url.origin) {
    throw new Error("Paperclip API response resolved to a different origin");
  }

  const contentType = response.headers.get("content-type")?.trim() ?? "";
  if (!JSON_CONTENT_TYPE_RE.test(contentType)) {
    throw new Error("Paperclip API response did not use a JSON content type");
  }

  const body = await response.json();
  return { body, response };
}

export function protectedPaperclipHeaders({
  health,
  apiUrl,
  requestUrl,
  env = process.env,
} = {}) {
  const mode = deploymentModeFromHealth(health);
  const apiKey = nonEmpty(env.PAPERCLIP_API_KEY);

  if (mode === "authenticated" && !apiKey) {
    throw new Error(
      "PAPERCLIP_API_KEY is required for protected Paperclip API requests in authenticated mode",
    );
  }

  if (!apiKey) return { Accept: "application/json" };

  paperclipRequestUrl(apiUrl, requestUrl);

  return {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}
