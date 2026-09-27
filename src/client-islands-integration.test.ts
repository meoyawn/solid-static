import { parse as parseJavaScript } from "acorn"
import { load as loadHtml } from "cheerio"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join, posix } from "node:path"
import { parse as parseCss } from "postcss"
import { describe, expect, test } from "vitest"
import { build, createServer as createViteServer, type Plugin, type UserConfig } from "vite"
import { staticSite } from "./index.ts"

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
  build: { minify: false, cssMinify: false, target: "es2020" },
  css: { modules: { generateScopedName: "client_[local]" } },
  define: { CLIENT_LABEL: JSON.stringify("defined") },
  mode: "client-fixture",
  plugins: [clientTransform()],
  resolve: { alias: { "@client": join(root, "src", "client") } },
})


// Resolve a generated public asset URL exactly as its containing HTML page does.
function outputAsset(url: string, route: string, base: string): string {
  const root = new URL(base, "http://solid-static.test/")
  const resolved = new URL(url, new URL(route, root))
  expect(resolved.origin).toEqual(root.origin)
  expect(resolved.pathname.startsWith(root.pathname)).toEqual(true)
  return resolved.pathname.slice(root.pathname.length)
}

async function assertJavaScriptFiles(directory: string): Promise<void> {
  const files = await readdir(directory, { recursive: true })
  const scripts = files.filter(file => file.endsWith(".js"))
  expect(scripts.length).toBeGreaterThan(0)
  await Promise.all(scripts.map(async file => {
    const source = await readFile(join(directory, file), "utf8")
    const program = parseJavaScript(source, { ecmaVersion: "latest", sourceType: "module" })
    expect(program.body.length).toBeGreaterThan(0)
    expect(source).not.toContain("__SOLID_STATIC_ISLAND_")
    for (const statement of program.body) {
      if (statement.type !== "ImportDeclaration") continue
      const imported = statement.source.value
      if (typeof imported !== "string") throw new TypeError("Expected a module URL")
      expect(imported.startsWith(".")).toEqual(true)
      expect(files).toContain(posix.normalize(posix.join(posix.dirname(file), imported)))
    }
  }))
}

function cssRules(source: string): Record<string, Record<string, string>> {
  const rules: Record<string, Record<string, string>> = {}
  parseCss(source).walkRules(rule => {
    const declarations: Record<string, string> = {}
    rule.walkDecls(declaration => { declarations[declaration.prop] = declaration.value })
    rules[rule.selector] = declarations
  })
  return rules
}

describe("client island output", () => {
  test.concurrent.each(clientBaseCases)("maps emitted assets with $name base", async ({ base }) => {
    expect(typeof document).toEqual("undefined")
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
      const outputFiles = await readdir(outputDirectory, { recursive: true })
      const styles: string[] = []
      const entries: string[] = []
      await Promise.all([
        { route: "index.html", name: "alpha", prefix: base, color: "rgb(11, 12, 13)" },
        { route: "beta/index.html", name: "beta", prefix: base === "./" ? "../" : base, color: "rgb(21, 22, 23)" },
      ].map(async ({ route, name, prefix, color }) => {
        const html = await readFile(join(outputDirectory, route), "utf8")
        const $ = loadHtml(html)
        expect($("title").text().toLowerCase()).toEqual(name)
        expect($("#" + name).text()).toEqual(name === "alpha" ? "Alpha fallback" : "Beta fallback")
        expect($("script[type=module][src]")).toHaveLength(1)
        expect($("link[rel=stylesheet][href]")).toHaveLength(1)
        expect(html).not.toContain("__SOLID_STATIC_ISLAND_")
        const script = $("script[type=module]").attr("src")
        const stylesheet = $("link[rel=stylesheet]").attr("href")
        if (script === undefined || stylesheet === undefined) throw new Error("Missing island assets")
        expect(script.startsWith(prefix + "assets/islands/")).toEqual(true)
        expect(stylesheet.startsWith(prefix + "assets/islands/")).toEqual(true)
        const scriptFile = outputAsset(script, route, base)
        const styleFile = outputAsset(stylesheet, route, base)
        expect(outputFiles).toContain(scriptFile)
        expect(outputFiles).toContain(styleFile)
        entries.push(scriptFile)
        styles.push(styleFile)
        const rules = cssRules(await readFile(join(outputDirectory, styleFile), "utf8"))
        expect(rules).toEqual({ [".client_" + name]: { color } })
        const javascript = await readFile(join(outputDirectory, scriptFile), "utf8")
        parseJavaScript(javascript, { ecmaVersion: 2020, sourceType: "module" })
        expect(javascript).toContain("client_" + name)
        expect(javascript).toContain("\n")
      }))
      expect(new Set(styles).size).toEqual(2)
      expect(new Set(entries).size).toEqual(2)
      const sharedFiles = outputFiles.filter(file => file.includes("/chunks/") && file.endsWith(".js"))
      expect(sharedFiles).toHaveLength(1)
      const sharedFile = sharedFiles[0]
      if (sharedFile === undefined) throw new Error("Missing shared module")
      const sharedJavaScript = await readFile(join(outputDirectory, sharedFile), "utf8")
      expect(sharedJavaScript).toContain('"defined"')
      expect(sharedJavaScript).toContain('"transformed"')
      expect(sharedJavaScript).toContain('"client-fixture"')
      expect(sharedJavaScript).not.toContain("__CLIENT_TRANSFORM__")
      const plain = loadHtml(await readFile(join(outputDirectory, "plain/index.html"), "utf8"))
      expect(plain("body").text()).toEqual("No islands here")
      expect(plain("script, link[rel=stylesheet]")).toHaveLength(0)
      expect(outputFiles).not.toContain(".vite/solid-static-islands-manifest.json")
      await assertJavaScriptFiles(outputDirectory)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 30_000)

  test("emits static fallback HTML with hashed JavaScript and deduplicated CSS links", async () => {
    const root = await createFixture()
    const outputDirectory = join(root, "dist")
    try {
      await build({
        build: { outDir: outputDirectory },
        logLevel: "silent",
        plugins: [staticSitePlugins()],
        root,
      })
      const html = await readFile(join(outputDirectory, "index.html"), "utf8")
      const $ = loadHtml(html)
      expect($("#fallback").text()).toEqual("Static fallback")
      expect($("#counter").text()).toEqual("Loading client island")
      expect($("button")).toHaveLength(0)
      expect(html).not.toContain("__SOLID_STATIC_ISLAND_")
      const scripts = $("script[type=module][src]").map((_index, element) => $(element).attr("src")).get()
      const styles = $("link[rel=stylesheet][href]").map((_index, element) => $(element).attr("href")).get()
      expect(scripts).toHaveLength(1)
      expect(scripts[0]).toMatch(/^\/assets\/islands\/[a-f0-9]+-[^/]+\.js$/)
      expect(styles).toHaveLength(2)
      expect(styles.filter(style => /^\/assets\/page-[^/]+\.css$/.test(style))).toHaveLength(1)
      expect(styles.filter(style => /^\/assets\/islands\/[^/]+\.css$/.test(style))).toHaveLength(1)
      const rules = Object.assign({}, ...await Promise.all(styles.map(async style =>
        cssRules(await readFile(join(outputDirectory, outputAsset(style, "index.html", "/")), "utf8")),
      )))
      expect(rules["body"]).toEqual({ margin: "0" })
      expect(rules["#counter button"]?.["color"]).toMatch(/^(?:#010203|rgb\(1,\s*2,\s*3\))$/)
      for (const script of scripts) await readFile(join(outputDirectory, outputAsset(script, "index.html", "/")))
      await assertJavaScriptFiles(outputDirectory)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 30_000)

  test("serves fallback HTML and transformed island assets during development", async () => {
    const root = await createFixture()
    const server = await createViteServer({
      appType: "spa",
      logLevel: "silent",
      plugins: [staticSitePlugins()],
      root,
      server: { hmr: false, host: "127.0.0.1", port: 0 },
    })
    try {
      await server.listen()
      const origin = server.resolvedUrls?.local[0]
      if (origin === undefined) throw new Error("Missing Vite development URL")
      const response = await fetch(origin, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(5_000) })
      expect(response.status).toEqual(200)
      const $ = loadHtml(await response.text())
      expect($("#fallback").text()).toEqual("Static fallback")
      expect($("#counter").text()).toEqual("Loading client island")
      const island = $("script[type=module][src='/src/counter-island.tsx']")
      expect(island).toHaveLength(1)
      const module = await fetch(new URL("/src/counter-island.tsx", origin), { signal: AbortSignal.timeout(5_000) })
      expect(module.status).toEqual(200)
      expect(module.headers.get("content-type")).toContain("javascript")
      const javascript = await module.text()
      parseJavaScript(javascript, { ecmaVersion: "latest", sourceType: "module" })
      expect(javascript).toContain("#counter")
      expect(javascript).toContain("Count ")
      const css = await fetch(new URL("/src/counter.css?direct", origin), { signal: AbortSignal.timeout(5_000) })
      expect(css.status).toEqual(200)
      expect(cssRules(await css.text())).toEqual({ "#counter button": { color: "rgb(1, 2, 3)" } })
    } finally {
      await server.close()
      await rm(root, { force: true, recursive: true })
    }
  }, 30_000)
})
