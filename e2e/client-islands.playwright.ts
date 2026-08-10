import { expect, test } from "@playwright/test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http"
import { extname, join } from "node:path"
import { build, createServer as createViteServer } from "vite"
import { staticSite } from "../src/index.ts"

interface ListeningServer {
  close: () => Promise<void>
  url: string
}

const staticSitePlugins = () =>
  staticSite({
    collections: {},
    i18n: {
      defaultLocale: "en",
      locales: ["en"],
      routing: { prefixDefaultLocale: false },
    },
    integrations: [],
    markdown: {
      processor: {
        async process() {
          return { toString: () => "" }
        },
      },
    },
    trailingSlash: "always",
  })

const listen = async (server: HttpServer): Promise<ListeningServer> => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()

  if (address === null || typeof address === "string") {
    throw new TypeError("Expected test server TCP address")
  }

  async function close(): Promise<void> {
    if (!server.listening) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error === undefined) {
          resolve()
        } else {
          reject(error)
        }
      })
      server.closeAllConnections()
    })
  }

  return { close, url: `http://127.0.0.1:${address.port}` }
}

const createFixture = async (): Promise<string> => {
  const root = await mkdtemp(join(process.cwd(), ".solid-static-islands-"))
  const sourceDirectory = join(root, "src")

  await mkdir(join(sourceDirectory, "pages"), { recursive: true })
  await Promise.all([
    writeFile(
      join(sourceDirectory, "pages", "index.tsx"),
      `import islandUrl from "../counter-island.tsx?island"

export default () => (
  <html lang="en">
    <head><title>Island fixture</title></head>
    <body>
      <p id="fallback">Static fallback</p>
      <div id="counter">Loading client island</div>
      <script type="module" src={islandUrl}></script>
    </body>
  </html>
)
`,
    ),
    writeFile(
      join(sourceDirectory, "counter-island.tsx"),
      `import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import "./counter.css"

const Counter = () => {
  const [count, setCount] = createSignal(0)

  return (
    <button type="button" onClick={() => setCount(value => value + 1)}>
      Count {count()}
    </button>
  )
}

const root = document.querySelector("#counter")

if (!(root instanceof HTMLElement)) {
  throw new TypeError("Missing #counter island root")
}

render(() => <Counter />, root)
`,
    ),
    writeFile(
      join(sourceDirectory, "counter.css"),
      `#counter button { color: rgb(1, 2, 3); }
`,
    ),
  ])

  return root
}

const createStaticServer = async (
  directory: string,
): Promise<ListeningServer> => {
  const server = createHttpServer((request, response) => {
    async function respond(): Promise<void> {
      const pathname = new URL(
        request.url ?? "/",
        "http://solid-static.local",
      ).pathname
      const fileName = pathname === "/" ? "index.html" : pathname.slice(1)

      try {
        const body = await readFile(join(directory, fileName))
        const contentTypes: Record<string, string> = {
          ".css": "text/css; charset=utf-8",
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
        }
        const contentType = contentTypes[extname(fileName)]

        response.statusCode = 200
        if (contentType !== undefined) {
          response.setHeader("Content-Type", contentType)
        }
        response.end(body)
      } catch {
        response.statusCode = 404
        response.end("Not found")
      }
    }

    void respond()
  })

  return listen(server)
}

test.describe("client islands", () => {
  test("builds hashed browser JavaScript and CSS that execute over static HTML", async ({
    page,
  }) => {
    const root = await createFixture()
    const outputDirectory = join(root, "dist")
    let server: ListeningServer | undefined

    try {
      await build({
        build: { outDir: outputDirectory },
        logLevel: "silent",
        plugins: [staticSitePlugins()],
        root,
      })
      const html = await readFile(join(outputDirectory, "index.html"), "utf8")

      expect(html).toContain("Static fallback")
      expect(html).not.toContain("__SOLID_STATIC_ISLAND_")
      expect(html).toMatch(
        /<script type="module" src="\/assets\/islands\/[a-f0-9]+-[^"]+\.js"><\/script>/,
      )
      expect(html).toMatch(
        /<link rel="stylesheet" href="\/assets\/islands\/[^"]+\.css">/,
      )

      server = await createStaticServer(outputDirectory)
      await page.goto(server.url)

      const counter = page.getByRole("button")
      await expect(counter).toHaveText("Count 0")
      await counter.click()
      await expect(counter).toHaveText("Count 1")
      await expect(counter).toHaveCSS("color", "rgb(1, 2, 3)")
    } finally {
      await server?.close()
      await rm(root, { force: true, recursive: true })
    }
  })

  test("serves and executes the source island during development", async ({
    page,
  }) => {
    const root = await createFixture()
    const viteServer = await createViteServer({
      appType: "spa",
      logLevel: "silent",
      plugins: [staticSitePlugins()],
      root,
      server: { hmr: false, host: "127.0.0.1", port: 0 },
    })

    try {
      await viteServer.listen()
      const url = viteServer.resolvedUrls?.local[0]

      if (url === undefined) {
        throw new TypeError("Vite did not expose a development URL")
      }

      await page.goto(url)

      const counter = page.getByRole("button")
      await expect(counter).toHaveText("Count 0")
      await counter.click()
      await expect(counter).toHaveText("Count 1")
      await expect(counter).toHaveCSS("color", "rgb(1, 2, 3)")
    } finally {
      await page.close()
      await viteServer.close()
      await rm(root, { force: true, recursive: true })
    }
  })
})
