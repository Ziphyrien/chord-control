import { defineConfig } from "@playwright/test";

const externalUrl = process.env.CHORD_UI_URL?.trim();

// Developer-only browser suite. CI performs static checks and cloud builds.
export default defineConfig({
  testDir: "./tests",
  testMatch: "ui.spec.ts",
  outputDir: "test-results",
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 30_000,
  use: {
    browserName: "chromium",
    baseURL: externalUrl ?? "http://127.0.0.1:1431",
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: externalUrl
    ? undefined
    : {
        command: "vp dev --mode ui-test --port 1431",
        url: "http://127.0.0.1:1431",
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      },
});
