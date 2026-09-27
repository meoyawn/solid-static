import { expect, test } from "@playwright/test"
import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { createServer, type ServerResponse } from "node:http"
import { join } from "node:path"
import { promisify } from "node:util"

const docker = promisify(execFile)

test.describe("shared browser service", () => {
  test("shares one Chromium process while isolating connections and contexts", async ({
    playwright,
  }, testInfo) => {
    const options = testInfo.project.use.connectOptions
    expect(options, "All browser tests must connect to Compose").toBeDefined()
    if (options === undefined) throw new Error("Missing shared browser endpoint")

    const marker = randomUUID()
    await using server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html")
      response.end(`<h1>${marker}</h1>`)
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (address === null || typeof address === "string") {
      throw new Error("Missing loopback test server address")
    }
    const origin = `http://localhost:${address.port}`
    const first = await playwright.chromium.connect(options)
    const second = await playwright.chromium.connect(options)
    try {
      const firstSession = await first.newBrowserCDPSession()
      const secondSession = await second.newBrowserCDPSession()
      const firstProcesses = await firstSession.send("SystemInfo.getProcessInfo")
      const secondProcesses = await secondSession.send("SystemInfo.getProcessInfo")
      const browserProcess = firstProcesses.processInfo.find(process => process.type === "browser")
      expect(browserProcess).toBeDefined()
      expect(secondProcesses.processInfo.find(process => process.type === "browser")?.id).toEqual(browserProcess?.id)
      await firstSession.detach()
      await secondSession.detach()
      const firstContext = await first.newContext()
      await firstContext.addCookies([{ name: "owner", value: marker, url: origin }])
      const firstPage = await firstContext.newPage()
      await firstPage.goto(origin)
      await expect(firstPage.getByRole("heading")).toHaveText(marker)

      const siblingContext = await first.newContext()
      expect(await siblingContext.cookies(origin)).toEqual([])
      const secondContext = await second.newContext()
      expect(await secondContext.cookies(origin)).toEqual([])
      const secondPage = await secondContext.newPage()
      await secondPage.goto(origin)
      await expect(secondPage.getByRole("heading")).toHaveText(marker)

      await first.close()
      expect(first.isConnected()).toEqual(false)
      expect(firstPage.isClosed()).toEqual(true)
      expect(second.isConnected()).toEqual(true)
      await secondPage.reload()
      await expect(secondPage.getByRole("heading")).toHaveText(marker)

      const next = await playwright.chromium.connect(options)
      try {
        expect(next.contexts()).toEqual([])
        const nextContext = await next.newContext()
        expect(await nextContext.cookies(origin)).toEqual([])
        const nextPage = await nextContext.newPage()
        await nextPage.goto(origin)
        await expect(nextPage.getByRole("heading")).toHaveText(marker)
      } finally {
        await next.close()
      }
    } finally {
      await first.close()
      await second.close()
    }
  })

  test("cleans up an interrupted client without closing other clients' tabs", async ({
    browser,
    page,
  }, testInfo) => {
    const options = testInfo.project.use.connectOptions
    if (options === undefined) throw new Error("Missing shared browser endpoint")
    const observer = await browser.newBrowserCDPSession()
    await observer.send("Target.setDiscoverTargets", { discover: true })
    await page.setContent("<h1>Survivor</h1>")
    const child = spawn(process.execPath, [
      "--input-type=module", "-e",
      `const { chromium } = await import(process.argv[1]);
       const browser = await chromium.connect(process.argv[2]);
       const context = await browser.newContext();
       const page = await context.newPage();
       await page.setContent('<h1>Interrupted client</h1>');
       const session = await context.newCDPSession(page);
       const { targetInfo } = await session.send('Target.getTargetInfo');
       process.send(targetInfo.targetId);`,
      import.meta.resolve("@playwright/test"), options.wsEndpoint,
    ], { stdio: ["ignore", "ignore", "inherit", "ipc"] })
    try {
      const [targetId]: unknown[] = await once(child, "message", {
        signal: AbortSignal.timeout(5_000),
      })
      expect(typeof targetId).toEqual("string")
      const destroyed = Promise.withResolvers<void>()
      observer.on("Target.targetDestroyed", event => {
        if (event.targetId === targetId) destroyed.resolve()
      })
      const exited = once(child, "exit")
      expect(child.kill("SIGKILL")).toEqual(true)
      await exited
      await destroyed.promise
      expect(browser.isConnected()).toEqual(true)
      await expect(page.getByRole("heading")).toHaveText("Survivor")
      expect(await page.evaluate(() => 2 + 2)).toEqual(4)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit")
        child.kill("SIGKILL")
        await exited
      }
      await observer.detach()
    }
  })

  test("keeps an in-flight script alive while Docker fixtures change networks", async ({
    page,
  }) => {
    const workspaceRoot = process.env["MOON_WORKSPACE_ROOT"]
    if (workspaceRoot === undefined) throw new Error("Missing Moon workspace root")
    const { stdout: image } = await docker("docker", [
      "compose", "-f", join(workspaceRoot, "compose/docker-compose.yaml"),
      "images", "-q", "playwright",
    ], { timeout: 5_000 })
    expect(image.trim()).not.toEqual("")
    const script = Promise.withResolvers<ServerResponse>()
    const marker = randomUUID()
    const network = `solid-static-browser-${marker}`
    const container = `${network}-fixture`
    await using server = createServer((request, response) => {
      if (request.url === "/held.js") {
        response.setHeader("Content-Type", "text/javascript")
        response.flushHeaders()
        script.resolve(response)
      } else {
        response.setHeader("Content-Type", "text/html")
        response.end('<h1>Waiting</h1><script src="/held.js"></script>')
      }
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (address === null || typeof address === "string") {
      throw new Error("Missing loopback test server address")
    }
    const failures: string[] = []
    page.on("requestfailed", request => {
      failures.push(`${request.url()}: ${request.failure()?.errorText}`)
    })
    await page.goto(`http://localhost:${address.port}`, { waitUntil: "commit" })
    const held = await script.promise
    try {
      await docker("docker", ["network", "create", network], { timeout: 5_000 })
      await docker("docker", [
        "run", "-d", "--name", container, "--network", network,
        "--entrypoint", "node", image.trim(),
        "-e", "require('node:net').createServer().listen(0, '127.0.0.1')",
      ], { timeout: 5_000 })
      await docker("docker", ["rm", "-f", container], { timeout: 5_000 })
      await docker("docker", ["network", "rm", network], { timeout: 5_000 })
      held.end(`document.querySelector('h1').textContent = '${marker}'`)
      await expect(page.getByRole("heading")).toHaveText(marker)
      expect(failures).toEqual([])
    } finally {
      held.end()
      await page.close()
      await docker("docker", ["rm", "-f", container]).catch(() => {})
      await docker("docker", ["network", "rm", network]).catch(() => {})
    }
  })
})
