import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Embedded PostgreSQL startup varies from ~2.9s to ~5.0s on paperclip01;
    // integration assertions are fast, so give the project stable boot headroom.
    testTimeout: 15_000,
  },
});
