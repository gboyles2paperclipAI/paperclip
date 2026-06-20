import { useContext } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Fallback client for hosts that render gated components without a
 * QueryClientProvider (isolated unit-test mounts, storybook-style renders).
 * The query is disabled in that case, so this client never fetches — it only
 * keeps `useQuery` from throwing. Created lazily so app code never pays for it.
 */
let detachedClient: QueryClient | null = null;
function getDetachedClient(): QueryClient {
  detachedClient ??= new QueryClient();
  return detachedClient;
}

/**
 * Conference Room Chat experimental flag (PAP-136 / PAP-137).
 * Also respects VITE_CHAT_DISABLED env var for safety gates.
 *
 * Returns:
 * - enabled: true when feature flag is on AND chat is not disabled by env var
 * - disabled: true when VITE_CHAT_DISABLED=true (emergency killswitch)
 * - loaded: false while query is in flight (prevents redirect flashing)
 *
 * Renders without a QueryClientProvider resolve to the flag-off default
 * (`{ enabled: false, disabled: false, loaded: true }`) instead of throwing.
 */
export function useConferenceRoomChatEnabled(): {
  enabled: boolean;
  disabled: boolean;
  loaded: boolean;
} {
  const contextClient = useContext(QueryClientContext);
  const chatDisabled = import.meta.env.VITE_CHAT_DISABLED === "true";

  const { data, isFetched } = useQuery(
    {
      queryKey: queryKeys.instance.experimentalSettings,
      queryFn: () => instanceSettingsApi.getExperimental(),
      enabled: contextClient != null,
    },
    contextClient ?? getDetachedClient(),
  );
  if (!contextClient) {
    return { enabled: false, disabled: chatDisabled, loaded: true };
  }
  return {
    enabled: data?.enableConferenceRoomChat === true && !chatDisabled,
    disabled: chatDisabled,
    loaded: isFetched
  };
}
