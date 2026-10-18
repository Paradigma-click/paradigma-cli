import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Runs in tests must never pop real desktop notifications.
    env: { PARADIGMA_NOTIFICATIONS: "off" },
  },
});
