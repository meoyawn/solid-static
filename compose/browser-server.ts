import { chromium } from "@playwright/test"
import { writeFile } from "node:fs/promises"

/** Compose owns the sole Chromium process; connections own only their contexts. */
const server = await chromium.launchServer({
  host: "127.0.0.1",
  port: 0,
  wsPath: "/",
  handleSIGINT: false,
  handleSIGTERM: false,
  handleSIGHUP: false,
})
let stopping = false

async function stop(): Promise<void> {
  stopping = true
  await server.close()
}

process.once("SIGINT", stop)
process.once("SIGTERM", stop)
process.once("SIGHUP", stop)
server.once("close", () => {
  process.exitCode = stopping ? 0 : 1
})
await writeFile("/tmp/playwright-endpoint", server.wsEndpoint())
console.log(`Playwright browser ready at ${server.wsEndpoint()}`)
