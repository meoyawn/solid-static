import { defineConfig, devices } from "@playwright/test"

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
  workers: 1,
})
