import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const chromiumExecutable =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  reporter: "list",
  workers: 1,
  use: {
    baseURL: process.env.TURNOCERTO_BASE_URL ?? "http://127.0.0.1:8788",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    launchOptions: chromiumExecutable ? { executablePath: chromiumExecutable } : {},
  },
});
