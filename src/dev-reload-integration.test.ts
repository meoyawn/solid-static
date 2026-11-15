import { once } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { load } from "cheerio"
import { describe, expect, test } from "vitest"
import { createServer, type ViteDevServer } from "vite"
import { staticSite } from "./index.ts"
import { createHtmlMarkdownProcessor } from "./markdown.ts"

describe("development reloads", () => {
  test("serves the latest Markdown pages when edits overlap an unfinished render", async () => {
    const root = await mkdtemp(join(process.cwd(), ".solid-static-reload-"))
    let server: ViteDevServer | undefined
    let socket: WebSocket | undefined
    const rendering = new EventTarget()
    const resume = Promise.withResolvers<void>()
    let pause = false
    const processor = createHtmlMarkdownProcessor()

    try {
      await mkdir(join(root, "src/pages"), { recursive: true })
      await mkdir(join(root, "src/layouts"), { recursive: true })
      const layout = join(root, "src/layouts/document.tsx")
      await Promise.all([
        writeFile(join(root, "src/pages/about.md"), "---\nlayout: ../layouts/document.tsx\n---\n# About this site\n"),
        writeFile(join(root, "src/pages/index.md"), "---\nlayout: ../layouts/document.tsx\n---\n# Still readable\n"),
        writeFile(layout, 'export default props => <html><body><header>Before edit</header><main>{props.children}</main></body></html>'),
      ])
      server = await createServer({
        configFile: false,
        logLevel: "silent",
        root,
        server: { host: "127.0.0.1", port: 0 },
        plugins: [staticSite({
          collections: {},
          i18n: { defaultLocale: "en", locales: ["en"], routing: { prefixDefaultLocale: false } },
          integrations: [],
          markdown: { processor: {
            parse: file => processor.parse(file),
            async run(tree, file) {
              if (pause && file.basename === "about.md") {
                pause = false
                rendering.dispatchEvent(new Event("paused"))
                await resume.promise
              }
              return processor.run(tree, file)
            },
          } },
          trailingSlash: "always",
        })],
      })
      await server.listen()
      const origin = server.resolvedUrls?.local[0]
      if (origin === undefined) throw new Error("Missing development server URL")
      const initial = await fetch(origin, { signal: AbortSignal.timeout(2_000) })
      expect(initial.status).toEqual(200)
      expect(load(await initial.text())("header").text()).toEqual("Before edit")

      const socketUrl = new URL(origin)
      socketUrl.protocol = "ws:"
      socketUrl.searchParams.set("token", server.config.webSocketToken)
      socket = new WebSocket(socketUrl, "vite-hmr")
      await once(socket, "open", { signal: AbortSignal.timeout(2_000) })
      function nextReload(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
          const signal = AbortSignal.timeout(2_000)
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          socket!.addEventListener("message", function onMessage(event) {
            if (JSON.parse(String(event.data)).type === "full-reload") {
              socket!.removeEventListener("message", onMessage)
              resolve()
            }
          }, { signal })
        })
      }
      const reload = nextReload()
      await writeFile(layout, 'export default props => <html><body><header>After edit</header><main>{props.children}</main></body></html>')
      await reload

      pause = true
      const paused = once(rendering, "paused", { signal: AbortSignal.timeout(2_000) })
      const pending = fetch(origin, { signal: AbortSignal.timeout(3_000) })
      await paused
      const secondReload = nextReload()
      await writeFile(layout, 'export default props => <html><body><header>Latest edit</header><main>{props.children}</main></body></html>')
      await secondReload
      const refreshed = await fetch(origin, { signal: AbortSignal.timeout(2_000) })
      const html = await refreshed.text()
      expect(refreshed.status, html).toEqual(200)
      const page = load(html)
      expect(page("header").text()).toEqual("Latest edit")
      expect(page("main h1").text()).toEqual("Still readable")

      resume.resolve()
      const overlapping = await pending
      const overlappingHtml = await overlapping.text()
      expect(overlapping.status, overlappingHtml).toEqual(200)
      expect(load(overlappingHtml)("header").text()).toEqual("Latest edit")
    } finally {
      resume.resolve()
      socket?.close()
      await server?.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)
})
