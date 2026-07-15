// Keep the in-process execution registry independent of heartbeat.ts so test
// database cleanup can wait for queued work without preloading the heartbeat
// service and its transitive dependencies before test mocks are installed.
export const activeHeartbeatRunExecutions = new Set<string>();
export const activeHeartbeatRunExecutionPromises = new Set<Promise<void>>();

export async function waitForAllHeartbeatRunExecutionsDrain(
  options: { timeoutMs?: number; intervalMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  while (activeHeartbeatRunExecutionPromises.size > 0) {
    if (Date.now() >= deadline) {
      const runIds = [...activeHeartbeatRunExecutions].sort();
      throw new Error(
        `Timed out waiting for ${activeHeartbeatRunExecutionPromises.size} heartbeat execution(s) to drain; ` +
        `run ids: ${runIds.length > 0 ? runIds.join(", ") : "registration pending"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
