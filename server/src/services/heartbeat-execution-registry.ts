// Keep the in-process execution registry independent of heartbeat.ts so test
// database cleanup can wait for queued work without preloading the heartbeat
// service and its transitive dependencies before test mocks are installed.
// Symbol.for also keeps transformed .js/.ts module instances on one registry.
interface HeartbeatExecutionRegistry {
  runIds: Set<string>;
  executions: Set<Promise<void>>;
  scheduling: Set<Promise<unknown>>;
}

const registryKey = Symbol.for("paperclip.heartbeatExecutionRegistry");
const existingRegistry = Reflect.get(globalThis, registryKey) as HeartbeatExecutionRegistry | undefined;
const registry: HeartbeatExecutionRegistry = existingRegistry ?? {
  runIds: new Set<string>(),
  executions: new Set<Promise<void>>(),
  scheduling: new Set<Promise<unknown>>(),
};

if (!existingRegistry) {
  Object.defineProperty(globalThis, registryKey, {
    value: registry,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

export const activeHeartbeatRunExecutions = registry.runIds;
export const activeHeartbeatRunExecutionPromises = registry.executions;
export const activeHeartbeatSchedulingPromises = registry.scheduling;

export function trackHeartbeatSchedulingPromise<T>(scheduling: Promise<T>) {
  activeHeartbeatSchedulingPromises.add(scheduling);
  void scheduling.then(
    () => activeHeartbeatSchedulingPromises.delete(scheduling),
    () => activeHeartbeatSchedulingPromises.delete(scheduling),
  );
  return scheduling;
}

export async function waitForAllHeartbeatRunExecutionsDrain(
  options: { timeoutMs?: number; intervalMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  while (
    activeHeartbeatRunExecutionPromises.size > 0 ||
    activeHeartbeatSchedulingPromises.size > 0
  ) {
    if (Date.now() >= deadline) {
      const runIds = [...activeHeartbeatRunExecutions].sort();
      throw new Error(
        `Timed out waiting for ${activeHeartbeatRunExecutionPromises.size} heartbeat execution(s) and ` +
        `${activeHeartbeatSchedulingPromises.size} scheduling operation(s) to drain; ` +
        `run ids: ${runIds.length > 0 ? runIds.join(", ") : "registration pending"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
