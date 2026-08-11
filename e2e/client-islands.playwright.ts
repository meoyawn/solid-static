import { expect, test } from "@playwright/test"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http"
import { extname, join } from "node:path"
import {
  build,
  createServer as createViteServer,
  type Plugin,
  type UserConfig,
} from "vite"
import { staticSite } from "../src/index.ts"

interface ListeningServer {
  close: () => Promise<void>
  url: string
}

const staticSitePlugins = (client?: UserConfig) =>
  staticSite({
    ...(client === undefined ? {} : { client }),
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

const clientBaseCases = [
  { base: "/", name: "root-absolute" },
  { base: "/docs/", name: "subpath" },
  { base: "./", name: "relative" },
  { base: "https://cdn.example.com/static/", name: "CDN" },
]

function clientTransform(): Plugin {
  return {
    name: "client-fixture-transform",
    transform(code, id) {
      return id.endsWith("/shared.ts")
        ? code.replace("__CLIENT_TRANSFORM__", "transformed")
        : undefined
    },
  }
}

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
import stylesheetUrl from "../page.css?url"

export default () => (
  <html lang="en">
    <head>
      <title>Island fixture</title>
      <link rel="stylesheet" href={stylesheetUrl} />
    </head>
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
    writeFile(
      join(sourceDirectory, "page.css"),
      `body { margin: 0; }
`,
    ),
  ])

  return root
}

const createMatrixFixture = async (): Promise<string> => {
  const root = await mkdtemp(join(process.cwd(), ".solid-static-matrix-"))
  const sourceDirectory = join(root, "src")
  const clientDirectory = join(sourceDirectory, "client")

  await mkdir(join(sourceDirectory, "pages"), { recursive: true })
  await mkdir(clientDirectory, { recursive: true })
  await Promise.all([
    writeFile(
      join(sourceDirectory, "pages", "index.tsx"),
      `import islandUrl from "../client/alpha.tsx?island"

export default () => (
  <html><head><title>Alpha</title></head><body>
    <div id="alpha">Alpha fallback</div>
    <script type="module" src={islandUrl}></script>
  </body></html>
)
`,
    ),
    writeFile(
      join(sourceDirectory, "pages", "beta.tsx"),
      `import islandUrl from "../client/beta.tsx?island"

export default () => (
  <html><head><title>Beta</title></head><body>
    <div id="beta">Beta fallback</div>
    <script type="module" src={islandUrl}></script>
  </body></html>
)
`,
    ),
    writeFile(
      join(sourceDirectory, "pages", "plain.tsx"),
      `export default () => (
  <html><head><title>Plain</title></head><body>No islands here</body></html>
)
`,
    ),
    writeFile(
      join(clientDirectory, "shared.ts"),
      `export const definedLabel = CLIENT_LABEL
export const mode = import.meta.env.MODE
export const transformedLabel = "__CLIENT_TRANSFORM__"
export const sharedPayload = "shared dependency payload retained as one chunk"
`,
    ),
    writeFile(
      join(clientDirectory, "alpha.tsx"),
      `import { render } from "solid-js/web"
import { definedLabel, mode, sharedPayload, transformedLabel } from "@client/shared.ts"
import styles from "./alpha.module.css"

const root = document.querySelector("#alpha")
if (!(root instanceof HTMLElement)) throw new TypeError("Missing alpha root")
render(() => <button class={styles.alpha}>{definedLabel}:{transformedLabel}:{mode}:alpha:{sharedPayload.length}</button>, root)
`,
    ),
    writeFile(
      join(clientDirectory, "beta.tsx"),
      `import { render } from "solid-js/web"
import { definedLabel, mode, sharedPayload, transformedLabel } from "@client/shared.ts"
import styles from "./beta.module.css"

const root = document.querySelector("#beta")
if (!(root instanceof HTMLElement)) throw new TypeError("Missing beta root")
render(() => <button class={styles.beta}>{definedLabel}:{transformedLabel}:{mode}:beta:{sharedPayload.length}</button>, root)
`,
    ),
    writeFile(
      join(clientDirectory, "alpha.module.css"),
      `.alpha { color: rgb(11, 12, 13); }
`,
    ),
    writeFile(
      join(clientDirectory, "beta.module.css"),
      `.beta { color: rgb(21, 22, 23); }
`,
    ),
  ])

  return root
}

const matrixClientConfig = (root: string): UserConfig => ({
  build: { minify: false, target: "es2020" },
  css: { modules: { generateScopedName: "client_[local]" } },
  define: { CLIENT_LABEL: JSON.stringify("defined") },
  mode: "client-fixture",
  plugins: [clientTransform()],
  resolve: { alias: { "@client": join(root, "src", "client") } },
})

const createStaticServer = async (
  directory: string,
): Promise<ListeningServer> => {
  const server = createHttpServer((request, response) => {
    async function respond(): Promise<void> {
      const pathname = new URL(
        request.url ?? "/",
        "http://solid-static.local",
      ).pathname
      const fileName =
        pathname === "/"
          ? "index.html"
          : pathname.endsWith("/")
            ? `${pathname.slice(1)}index.html`
            : pathname.slice(1)

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
  for (const { base, name } of clientBaseCases) {
    test(`maps split CSS and client config with ${name} base`, async () => {
      const root = await createMatrixFixture()
      const outputDirectory = join(root, "dist")

      try {
        await build({
          base,
          build: { minify: false, outDir: outputDirectory },
          logLevel: "silent",
          plugins: [staticSitePlugins(matrixClientConfig(root))],
          root,
        })

        const alphaHtml = await readFile(
          join(outputDirectory, "index.html"),
          "utf8",
        )
        const betaHtml = await readFile(
          join(outputDirectory, "beta", "index.html"),
          "utf8",
        )
        const plainHtml = await readFile(
          join(outputDirectory, "plain", "index.html"),
          "utf8",
        )
        const alphaStyles = [...alphaHtml.matchAll(/href="([^"]+\.css)"/g)]
          .map(match => match[1])
        const betaStyles = [...betaHtml.matchAll(/href="([^"]+\.css)"/g)]
          .map(match => match[1])
        const alphaScripts = [...alphaHtml.matchAll(/src="([^"]+\.js)"/g)]
          .map(match => match[1])
        const betaScripts = [...betaHtml.matchAll(/src="([^"]+\.js)"/g)]
          .map(match => match[1])
        const outputFiles = await readdir(outputDirectory, { recursive: true })
        const islandFiles = outputFiles.filter(fileName =>
          fileName.startsWith("assets/islands/"),
        )
        const cssFiles = islandFiles.filter(fileName => fileName.endsWith(".css"))
        const cssSources = await Promise.all(
          cssFiles.map(fileName => readFile(join(outputDirectory, fileName), "utf8")),
        )
        const entryJavaScript = await Promise.all(
          islandFiles
            .filter(
              fileName =>
                fileName.endsWith(".js") && !fileName.includes("/chunks/"),
            )
            .map(fileName => readFile(join(outputDirectory, fileName), "utf8")),
        )
        const sharedJavaScript = await readFile(
          join(
            outputDirectory,
            islandFiles.find(
              fileName =>
                fileName.includes("/chunks/") && fileName.endsWith(".js"),
            ) ?? "missing-shared-chunk",
          ),
          "utf8",
        )
        const expectedRootPrefix = base
        const expectedNestedPrefix = base === "./" ? "../" : base
        const escapedRootPrefix = expectedRootPrefix.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        )
        const escapedNestedPrefix = expectedNestedPrefix.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        )

        expect(alphaStyles).toHaveLength(1)
        expect(betaStyles).toHaveLength(1)
        expect(alphaScripts).toHaveLength(1)
        expect(betaScripts).toHaveLength(1)
        expect(alphaStyles[0]).not.toEqual(betaStyles[0])
        expect(alphaStyles[0]).toMatch(
          new RegExp(`^${escapedRootPrefix}assets/islands/`),
        )
        expect(betaStyles[0]).toMatch(
          new RegExp(`^${escapedNestedPrefix}assets/islands/`),
        )
        expect(alphaScripts[0]).toMatch(
          new RegExp(`^${escapedRootPrefix}assets/islands/`),
        )
        expect(betaScripts[0]).toMatch(
          new RegExp(`^${escapedNestedPrefix}assets/islands/`),
        )
        expect(cssSources.some(source => source.includes(".client_alpha"))).toEqual(true)
        expect(cssSources.some(source => source.includes(".client_beta"))).toEqual(true)
        expect(
          islandFiles.filter(fileName => fileName.includes("/chunks/") && fileName.endsWith(".js")),
        ).toHaveLength(1)
        expect(entryJavaScript.every(source => source.includes("\n"))).toEqual(true)
        expect(sharedJavaScript).toContain('"defined"')
        expect(sharedJavaScript).toContain('"transformed"')
        expect(sharedJavaScript).toContain('"client-fixture"')
        expect(plainHtml).toContain("No islands here")
        expect(plainHtml).not.toContain("assets/islands/")
        expect(outputFiles).not.toContain(".vite/solid-static-islands-manifest.json")
      } finally {
        await rm(root, { force: true, recursive: true })
      }
    })
  }

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
      expect(
        html.match(
          /<link rel="stylesheet" href="\/assets\/page-[^"]+\.css">/g,
        ),
      ).toHaveLength(1)

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
