import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    setupFiles: [
      "./src/__tests__/setup-paperclip-home.ts",
      "./src/__tests__/setup-supertest.ts",
    ],
    // First-load route imports vary from ~1.9s to ~5.0s on paperclip01;
    // requests/assertions are tens of milliseconds, so allow stable boot headroom.
    testTimeout: 15_000,
  },
});
