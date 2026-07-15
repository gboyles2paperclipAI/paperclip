import {
  getEmbeddedPostgresTestSupport,
  type EmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestSupport,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase as startDb } from "@paperclipai/db";
import { waitForAllHeartbeatRunExecutionsDrain } from "../../services/heartbeat.ts";

export { getEmbeddedPostgresTestSupport };
export type { EmbeddedPostgresTestDatabase, EmbeddedPostgresTestSupport };

export async function startEmbeddedPostgresTestDatabase(...args: Parameters<typeof startDb>) {
  const started = await startDb(...args);
  return {
    ...started,
    cleanup: async () => {
      await waitForAllHeartbeatRunExecutionsDrain({ timeoutMs: 15_000 });
      await started.cleanup();
    },
  };
}
