import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["**/node_modules/**", "src/**/*.browser.test.ts"],
        },
      },
      {
        extends: true,
        optimizeDeps: {
          include: [
            "@tanstack/query-async-storage-persister",
            "@tanstack/query-persist-client-core",
          ],
        },
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.ts"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({
              launchOptions: { args: ["--enable-blink-features=MessagePortCloseEvent"] },
            }),
            screenshotFailures: false,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
