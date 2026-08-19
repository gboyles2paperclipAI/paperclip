import type { AcpRuntimeStatus } from "acpx/runtime";

export interface AcpxSessionConfigRequest {
  key: string;
  value: string;
  category?: string;
}

interface AdvertisedConfigOption {
  id: string;
  category?: string;
}

function advertisedConfigOptions(
  status: AcpRuntimeStatus | null,
): AdvertisedConfigOption[] | null {
  const rawOptions = status?.details?.configOptions;
  if (!Array.isArray(rawOptions)) return null;

  return rawOptions.flatMap((rawOption) => {
    if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) return [];
    const option = rawOption as Record<string, unknown>;
    if (typeof option.id !== "string" || option.id.trim().length === 0) return [];
    return [{
      id: option.id,
      ...(typeof option.category === "string" && option.category.trim().length > 0
        ? { category: option.category }
        : {}),
    }];
  });
}

/**
 * Resolve a requested session setting against the schema negotiated with the
 * ACP agent. A null status means the runtime cannot expose that schema, so the
 * requested key is preserved for compatibility with older ACPX versions.
 */
export function resolveAdvertisedSessionConfigOption(
  status: AcpRuntimeStatus | null,
  requested: AcpxSessionConfigRequest,
): AcpxSessionConfigRequest | null {
  const advertised = advertisedConfigOptions(status);
  if (advertised === null) return requested;

  const exact = advertised.find((option) => option.id === requested.key);
  if (exact) return requested;

  if (requested.category) {
    const categoryMatch = advertised.find(
      (option) => option.category === requested.category,
    );
    if (categoryMatch) return { ...requested, key: categoryMatch.id };
  }

  return null;
}
