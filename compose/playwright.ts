import { execFileSync } from "node:child_process"
import { join } from "node:path"

/** Connect workers to the sole browser in the workspace's shared Compose service. */
export function browserConnectOptions() {
  const workspaceRoot = process.env["MOON_WORKSPACE_ROOT"]
  if (workspaceRoot === undefined) {
    throw new Error(
      "Run browser tests through Moon so compose:up-d provides Playwright",
    )
  }
  const address = execFileSync(
    "docker",
    [
      "compose", "-f", join(workspaceRoot, "compose/docker-compose.yaml"),
      "exec", "-T", "playwright", "node", "-p",
      "require('node:fs').readFileSync('/tmp/playwright-endpoint', 'utf8')",
    ],
    { encoding: "utf8", timeout: 5_000 },
  ).trim()
  if (!/^ws:\/\/127\.0\.0\.1:\d+\/$/u.test(address)) {
    throw new Error(
      `Compose Playwright must expose one loopback endpoint; received ${JSON.stringify(address)}`,
    )
  }
  const endpoint = new URL(address)
  endpoint.hostname = "localhost"
  return {
    wsEndpoint: endpoint.href,
    timeout: 5_000,
  }
}
