import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { basename, dirname, extname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { load } from "js-yaml"
import type { Plugin, PluginOption, ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import {
  loadCollections,
  type CollectionDefinitions,
  type MarkdownProcessor,
} from "./content.ts"

export interface StaticSiteI18nOptions {
  defaultLocale: string
  locales: string[]
  routing: {
    prefixDefaultLocale: boolean
  }
}

export interface StaticSiteOptions {
  collections: CollectionDefinitions
  i18n: StaticSiteI18nOptions
  integrations: PluginOption[]
  markdown: {
    processor: MarkdownProcessor
  }
  trailingSlash: "always" | "never"
}

interface ResolvedStaticSiteOptions extends StaticSiteOptions {
  collections: CollectionDefinitions
  pagesDirectory: string
}

interface DiscoveredDocumentPage {
  fileName: string
  kind: "document"
  layoutPath: string
  pagePath: string
  routePath: string
}

interface DiscoveredComponentPage {
  fileName: string
  kind: "component"
  pagePath: string
  routePath: string
}

type DiscoveredPage = DiscoveredComponentPage | DiscoveredDocumentPage

interface StaticSiteRoute {
  fileName: string
  html: string
}

interface GeneratedStaticSiteModule {
  default: () => Promise<unknown>
}

interface StaticSiteEntry {
  code: string
  dynamicImports: string[]
  imports: string[]
}

const entryId = "virtual:vite-static-site-entry"
const resolvedEntryId = `\0${entryId}`
const devRoutesPath = "/@vite-static-site/routes.json"
const pageExtensions = new Set([".md", ".mdx", ".tsx"])
const rendererPath = fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "./render.tsx" : "./render.jsx", import.meta.url),
)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isGeneratedStaticSiteModule = (
  value: unknown,
): value is GeneratedStaticSiteModule =>
  isRecord(value) && typeof value.default === "function"

const isStaticSiteRoute = (value: unknown): value is StaticSiteRoute =>
  isRecord(value) &&
  typeof value.fileName === "string" &&
  typeof value.html === "string"

const requireRoutes = (value: unknown): StaticSiteRoute[] => {
  if (!Array.isArray(value) || !value.every(isStaticSiteRoute)) {
    throw new TypeError("Static-site renderer returned invalid routes")
  }

  return value
}

const executableEntryCode = (entry: StaticSiteEntry): string => {
  let code = entry.code

  for (const specifier of [...entry.imports, ...entry.dynamicImports]) {
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      throw new TypeError(
        `Static-site SSR entry contains unsupported relative import ${specifier}`,
      )
    }

    const resolved = import.meta.resolve(specifier)
    code = code
      .replaceAll(`"${specifier}"`, `"${resolved}"`)
      .replaceAll(`'${specifier}'`, `'${resolved}'`)
  }

  return code
}

const withStyleSheets = (
  html: string,
  styleSheets: readonly string[],
): string => {
  if (styleSheets.length === 0) {
    return html
  }

  const links = styleSheets
    .map(fileName => {
      const href = fileName.startsWith("/") ? fileName : `/${fileName}`
      return `<link rel="stylesheet" href="${href}">`
    })
    .join("")

  if (!html.includes("</head>")) {
    throw new TypeError("Static-site route has no closing head element")
  }

  return html.replace("</head>", `${links}</head>`)
}

const resolveOptions = (
  options: StaticSiteOptions,
  root: string,
): ResolvedStaticSiteOptions => ({
  ...options,
  collections: Object.fromEntries(
    Object.entries(options.collections).map(([name, definition]) => [
      name,
      { ...definition, directory: resolve(root, definition.directory) },
    ]),
  ),
  pagesDirectory: join(root, "src", "pages"),
})

const validateOptions = (options: ResolvedStaticSiteOptions): void => {
  if (!options.i18n.locales.includes(options.i18n.defaultLocale)) {
    throw new TypeError("i18n.defaultLocale must exist in i18n.locales")
  }

  if (new Set(options.i18n.locales).size !== options.i18n.locales.length) {
    throw new TypeError("i18n.locales must not contain duplicates")
  }

}

const parsePageFrontmatter = (
  source: string,
  pagePath: string,
): Record<string, unknown> => {
  const match = source.match(/^---\n(?<frontmatter>[\s\S]*?)\n---/)
  const frontmatterSource = match?.groups?.frontmatter

  if (frontmatterSource === undefined) {
    throw new TypeError(`${pagePath} requires YAML frontmatter`)
  }

  const frontmatter = load(frontmatterSource)

  if (!isRecord(frontmatter)) {
    throw new TypeError(`${pagePath} requires object frontmatter`)
  }

  return frontmatter
}

const routePathFor = (relativePath: string): string => {
  const pathWithoutExtension = relativePath.slice(
    0,
    -extname(relativePath).length,
  )

  if (pathWithoutExtension === "404") {
    return "404"
  }

  return pathWithoutExtension.replace(/(?:^|\/)index$/, "")
}

const routeFileName = (
  routePath: string,
  trailingSlash: StaticSiteOptions["trailingSlash"],
): string => {
  const normalized = routePath.replace(/^\/+|\/+$/g, "")

  if (normalized === "404") {
    return "404.html"
  }

  if (normalized === "") {
    return "index.html"
  }

  return trailingSlash === "always"
    ? `${normalized}/index.html`
    : `${normalized}.html`
}

const localeForRoute = (
  routePath: string,
  i18n: StaticSiteI18nOptions,
): string => {
  const [firstSegment] = routePath.split("/")
  const explicitLocale = i18n.locales.find(locale => locale === firstSegment)

  if (
    explicitLocale === i18n.defaultLocale &&
    !i18n.routing.prefixDefaultLocale
  ) {
    throw new TypeError(
      `Default locale route ${routePath} must not use the ${i18n.defaultLocale} prefix`,
    )
  }

  return explicitLocale ?? i18n.defaultLocale
}

const discoverPages = async (
  options: ResolvedStaticSiteOptions,
): Promise<DiscoveredPage[]> => {
  const entries = await readdir(options.pagesDirectory, {
    recursive: true,
    withFileTypes: true,
  })
  const paths = entries
    .filter(
      entry =>
        entry.isFile() &&
        pageExtensions.has(extname(entry.name)),
    )
    .map(entry => join(entry.parentPath, entry.name))
    .sort()

  const pages = await Promise.all(
    paths.map(async pagePath => {
      const relativePath = relative(options.pagesDirectory, pagePath)
      const routePath = routePathFor(relativePath)
      const extension = extname(relativePath)

      const locale = localeForRoute(routePath, options.i18n)

      if (extension !== ".md" && extension !== ".mdx") {
        return {
          fileName: routeFileName(routePath, options.trailingSlash),
          kind: "component",
          pagePath,
          routePath,
        } satisfies DiscoveredComponentPage
      }

      const frontmatter = parsePageFrontmatter(
        await readFile(pagePath, "utf8"),
        pagePath,
      )
      const layout = frontmatter.layout
      const declaredLocale = frontmatter.lang

      if (typeof layout !== "string") {
        throw new TypeError(`${relativePath} requires a layout in frontmatter`)
      }

      if (
        declaredLocale !== undefined &&
        typeof declaredLocale !== "string"
      ) {
        throw new TypeError(`${relativePath} frontmatter lang must be a string`)
      }

      if (
        declaredLocale !== undefined &&
        declaredLocale !== locale
      ) {
        throw new TypeError(
          `${relativePath} declares locale ${declaredLocale} but routes as ${locale}`,
        )
      }

      return {
        fileName: routeFileName(routePath, options.trailingSlash),
        kind: "document",
        layoutPath: resolve(dirname(pagePath), layout),
        pagePath,
        routePath,
      } satisfies DiscoveredDocumentPage
    }),
  )

  return pages.filter(
    (page): page is DiscoveredPage => page !== undefined,
  )
}

const isDocumentPage = (
  page: DiscoveredPage,
): page is DiscoveredDocumentPage => page.kind === "document"

const isComponentPage = (
  page: DiscoveredPage,
): page is DiscoveredComponentPage => page.kind === "component"

const serialize = (value: unknown): string => {
  if (value === undefined) {
    return "undefined"
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value)
  }

  if (value instanceof Date) {
    return `new Date(${JSON.stringify(value.toISOString())})`
  }

  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(",")}]`
  }

  if (isRecord(value)) {
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}:${serialize(item)}`)
      .join(",")}}`
  }

  throw new TypeError(`Cannot serialize ${typeof value} static-site data`)
}

const virtualEntry = async (
  options: ResolvedStaticSiteOptions,
): Promise<string> => {
  const collections = await loadCollections(
    options.collections,
    options.markdown.processor,
  )
  const pages = await discoverPages(options)
  const documentPages = pages.filter(isDocumentPage)
  const componentPages = pages.filter(isComponentPage)
  const indexedComponentPages = componentPages.map((page, index) => ({
    index,
    page,
  }))
  const staticComponentPages = indexedComponentPages.filter(
    ({ page }) => !page.routePath.includes("["),
  )
  const dynamicComponentPages = indexedComponentPages.filter(({ page }) =>
    page.routePath.includes("["),
  )
  const fileNames = [
    ...documentPages.map(page => page.fileName),
    ...staticComponentPages.map(({ page }) => page.fileName),
  ]

  if (new Set(fileNames).size !== fileNames.length) {
    throw new TypeError("Static-site routes must emit unique file names")
  }
  const pageImports = documentPages
    .map(
      (page, index) =>
        `import Page${index}, { frontmatter as frontmatter${index} } from ${JSON.stringify(page.pagePath)}\nimport Layout${index} from ${JSON.stringify(page.layoutPath)}`,
    )
    .join("\n")
  const componentImports = componentPages
    .map(
      (page, index) =>
        `import * as ComponentPage${index} from ${JSON.stringify(page.pagePath)}`,
    )
    .join("\n")
  const pageRecords = documentPages
    .map(
      (page, index) =>
        `{ Content: Page${index}, Layout: Layout${index}, fileName: ${JSON.stringify(page.fileName)}, frontmatter: frontmatter${index}, routePath: ${JSON.stringify(page.routePath)} }`,
    )
    .join(",\n")
  const staticComponentRecords = staticComponentPages
    .map(
      ({ index, page }) =>
        `{ Content: ComponentPage${index}.default, fileName: ${JSON.stringify(page.fileName)}, path: ${JSON.stringify(page.routePath)}, props: {} }`,
    )
    .join(",\n")
  const dynamicComponentRecords = dynamicComponentPages
    .map(
      ({ index, page }) =>
        `{ Content: ComponentPage${index}.default, getStaticPaths: ComponentPage${index}.getStaticPaths, pattern: ${JSON.stringify(page.routePath)} }`,
    )
    .join(",\n")
  const collectionValues = Object.fromEntries(
    Object.entries(collections).map(([name, entries]) => [
      name,
      entries,
    ]),
  )

  return `
import { renderStaticSite } from ${JSON.stringify(rendererPath)}
import { setCollections } from "vite-static-site/runtime"
${pageImports}
${componentImports}

export default async function generateStaticSite() {
  const collections = ${serialize(collectionValues)}
  setCollections(collections)

  return renderStaticSite({
    collections,
    documentPages: [${pageRecords}],
    dynamicPages: [${dynamicComponentRecords}],
    staticPages: [${staticComponentRecords}],
    trailingSlash: ${JSON.stringify(options.trailingSlash)},
  })
}
`
}

const requestFileName = (
  pathname: string,
  trailingSlash: StaticSiteOptions["trailingSlash"],
): string => {
  const requestedPath = decodeURIComponent(pathname).replace(/^\//, "")

  if (requestedPath === "" || requestedPath.endsWith("/")) {
    return `${requestedPath}index.html`
  }

  if (requestedPath.endsWith(".html")) {
    return requestedPath
  }

  return trailingSlash === "always"
    ? `${requestedPath}/index.html`
    : `${requestedPath}.html`
}

const rewriteDevAssetUrls = (
  html: string,
  assets: Map<string, string>,
): string =>
  html.replace(
    /(?<prefix>\b(?:href|src)=")(?<href>\/[^"\s]+\?[^"\s]*no-inline[^"\s]*)(?<suffix>")/g,
    (match, ...args: unknown[]) => {
      const groups = args.at(-1)

      if (!isRecord(groups)) {
        return match
      }

      const prefix = groups.prefix
      const href = groups.href
      const suffix = groups.suffix

      if (
        typeof prefix !== "string" ||
        typeof href !== "string" ||
        typeof suffix !== "string"
      ) {
        return match
      }

      const pathname = new URL(href, "http://vite-static-site.local").pathname
      const extension = extname(pathname)
      const name = basename(pathname, extension)
      const hash = createHash("sha256").update(href).digest("hex").slice(0, 8)
      const publicPath = `/assets/${name}-${hash}${extension}`
      assets.set(publicPath, href)
      return `${prefix}${publicPath}${suffix}`
    },
  )

const serveStaticSite = (
  server: ViteDevServer,
  options: ResolvedStaticSiteOptions,
): (() => void) => {
  let routesPromise: Promise<StaticSiteRoute[]> | undefined
  const assets = new Map<string, string>()
  const discoveryRoots = [
    options.pagesDirectory,
    ...Object.values(options.collections).map(collection =>
      resolve(collection.directory),
    ),
  ]

  async function routes(): Promise<StaticSiteRoute[]> {
    routesPromise ??= server.ssrLoadModule(entryId).then(async module => {
      if (!isGeneratedStaticSiteModule(module)) {
        throw new TypeError("Vite loaded an invalid static-site module")
      }

      return requireRoutes(await module.default())
    })

    return routesPromise
  }

  const invalidateRoutes = (): void => {
    routesPromise = undefined
    assets.clear()
    const entryModule = server.moduleGraph.getModuleById(resolvedEntryId)

    if (entryModule !== undefined) {
      server.moduleGraph.invalidateModule(entryModule)
    }

    server.ws.send({ type: "full-reload" })
  }
  const rediscover = (filePath: string): void => {
    const absolutePath = resolve(filePath)

    if (
      discoveryRoots.some(
        root => absolutePath === root || absolutePath.startsWith(`${root}/`),
      )
    ) {
      invalidateRoutes()
    }
  }

  const styleSheets = (): string[] =>
    [
      ...new Set(
        [...server.moduleGraph.idToModuleMap.values()]
          .map(module => module.url)
          .filter(url => new URL(url, "http://vite-static-site.local").pathname.endsWith(".css")),
      ),
    ].sort()

  server.watcher.on("add", rediscover)
  server.watcher.on("unlink", rediscover)

  server.middlewares.use(function staticSiteMiddleware(
    request,
    response,
    next,
  ) {
    async function handleRequest(): Promise<void> {
      if (request.url === undefined) {
        next()
        return
      }

      const requestUrl = new URL(request.url, "http://vite-static-site.local")
      const assetTarget = assets.get(requestUrl.pathname)

      if (assetTarget !== undefined) {
        response.statusCode = 302
        response.setHeader("Location", assetTarget)
        response.end()
        return
      }

      if (requestUrl.pathname === devRoutesPath) {
        response.statusCode = 200
        response.setHeader("Content-Type", "application/json")
        response.end(
          JSON.stringify((await routes()).map(route => route.fileName)),
        )
        return
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        next()
        return
      }

      const generatedRoutes = await routes()
      let route = generatedRoutes.find(
        candidate =>
          candidate.fileName ===
          requestFileName(requestUrl.pathname, options.trailingSlash),
      )
      let statusCode = 200

      if (route === undefined) {
        const acceptsHtml = request.headers.accept?.includes("text/html") ?? false
        const requestedExtension = extname(requestUrl.pathname)

        if (
          !acceptsHtml ||
          (requestedExtension !== "" && requestedExtension !== ".html")
        ) {
          next()
          return
        }

        route = generatedRoutes.find(candidate => candidate.fileName === "404.html")

        if (route === undefined) {
          next()
          return
        }

        statusCode = 404
      }

      const transformed = await server.transformIndexHtml(
        requestUrl.pathname,
        withStyleSheets(route.html, styleSheets()),
      )
      const html = rewriteDevAssetUrls(transformed, assets)

      response.statusCode = statusCode
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      response.end(request.method === "HEAD" ? undefined : html)
    }

    void handleRequest().catch(error => {
      if (error instanceof Error) {
        server.ssrFixStacktrace(error)
      }

      next(error)
    })
  })

  return invalidateRoutes
}

const staticSitePlugin = (unresolved: StaticSiteOptions): Plugin => {
  let options = resolveOptions(unresolved, process.cwd())
  let invalidateRoutes = (): void => undefined

  return {
    name: "vite-static-site",
    configResolved(config) {
      options = resolveOptions(unresolved, config.root)
      validateOptions(options)
    },
    config(_config, environment) {
      if (environment.command === "serve") {
        return undefined
      }

      return {
        build: {
          ssr: true,
          ssrEmitAssets: true,
          rolldownOptions: {
            input: entryId,
            output: {
              assetFileNames: "assets/[name]-[hash][extname]",
              codeSplitting: false,
            },
          },
        },
        ssr: {
          noExternal: true,
        },
      }
    },
    resolveId(id) {
      return id === entryId ? resolvedEntryId : undefined
    },
    load(id) {
      return id === resolvedEntryId ? virtualEntry(options) : undefined
    },
    configureServer(server) {
      invalidateRoutes = serveStaticSite(server, options)
    },
    handleHotUpdate() {
      invalidateRoutes()
    },
    async generateBundle(_outputOptions, bundle) {
      const entry = Object.values(bundle).find(
        output => output.type === "chunk" && output.isEntry,
      )

      if (entry?.type !== "chunk") {
        throw new Error("Vite did not emit the static site's SSR entry")
      }

      const moduleUrl = `data:text/javascript;base64,${Buffer.from(executableEntryCode(entry)).toString("base64")}`
      const generatedModule: unknown = await import(moduleUrl)

      if (!isGeneratedStaticSiteModule(generatedModule)) {
        throw new TypeError("Vite emitted an invalid static-site module")
      }

      const routes = requireRoutes(await generatedModule.default())
      const styleSheets = Object.values(bundle)
        .filter(
          output =>
            output.type === "asset" && output.fileName.endsWith(".css"),
        )
        .map(output => output.fileName)
        .sort()

      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === "chunk") {
          delete bundle[fileName]
        }
      }

      for (const route of routes) {
        this.emitFile({
          type: "asset",
          fileName: route.fileName,
          source: withStyleSheets(route.html, styleSheets),
        })
      }
    },
  }
}

export const staticSite = (options: StaticSiteOptions): PluginOption => [
  ...options.integrations,
  solid({ ssr: true }),
  staticSitePlugin(options),
]
