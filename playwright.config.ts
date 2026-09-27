import { defineConfig, devices } from "@playwright/test"
import { browserConnectOptions } from "./compose/playwright.ts"

export default defineConfig({
  fullyParallel: false,
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  reporter: "list",
  testDir: "./e2e",
  testMatch: "**/*.playwright.ts",
  timeout: 30_000,
  use: { connectOptions: browserConnectOptions() },
  workers: 1,
})
