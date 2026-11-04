import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, extname, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { CORE_SCHEMA, load, timestampTag } from "js-yaml"
import {
  isRunnableDevEnvironment,
  type Plugin,
  type PluginOption,
  type UserConfig,
  type ViteDevServer,
} from "vite"
import solid from "vite-plugin-solid"
import {
  loadCollections,
  type CollectionDefinitions,
  type MarkdownProcessor,
} from "./content.ts"
import {
  createClientIslands,
  type ClientIslands,
} from "./client-islands.ts"
import {
  createMarkdownSiblings,
  type StaticSiteMarkdownExportOptions,
} from "./markdown-export.ts"
import { markdownImages } from "./markdown-images.ts"
import type { Root } from "hast"
import type { RenderEnvironment } from "./render-environment.ts"
import { createRenderAssets } from "./render-assets.ts"
import { renderJsx } from "./render-jsx.ts"

const yamlSchema = CORE_SCHEMA.withTags(timestampTag)

export interface StaticSiteI18nOptions {
  defaultLocale: string
  locales: string[]
  routing: {
    prefixDefaultLocale: boolean
  }
}

export interface StaticSiteSitemapOptions {
  /** Canonical site origin used for sitemap `<loc>` values. */
  site: string
  /** ISO 8601 modification date used for every emitted URL; omitted when absent. */
  lastmod?: string
}

export type { StaticSiteMarkdownExportOptions }

export interface StaticSiteOptions {
  client?: UserConfig
  collections: CollectionDefinitions
  i18n: StaticSiteI18nOptions
  integrations: PluginOption[]
  markdown: {
    processor: MarkdownProcessor
  }
  markdownExport?: StaticSiteMarkdownExportOptions
  sitemap?: StaticSiteSitemapOptions
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
  tree: Root
}

interface GeneratedStaticSiteModule {
  default: (environment: RenderEnvironment) => Promise<unknown>
}

const entryId = "virtual:solid-static-entry"
const resolvedEntryId = `\0${entryId}`
const devRoutesPath = "/@solid-static/routes.json"
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
  typeof value.html === "string" &&
  isRecord(value.tree) && value.tree.type === "root" && Array.isArray(value.tree.children)

const requireRoutes = (value: unknown): StaticSiteRoute[] => {
  if (!Array.isArray(value) || !value.every(isStaticSiteRoute)) {
    throw new TypeError("Static-site renderer returned invalid routes")
  }

  return value
}

async function renderGeneratedModule(
  code: string,
  root: string,
  environment: RenderEnvironment,
): Promise<StaticSiteRoute[]> {
  const directory = await mkdtemp(join(root, ".solid-static-render-"))
  try {
    const modulePath = join(directory, "entry.mjs")
    await writeFile(modulePath, code)
    const module: unknown = await import(pathToFileURL(modulePath).href)
    if (!isGeneratedStaticSiteModule(module)) throw new TypeError("Vite emitted an invalid static-site module")
    return requireRoutes(await module.default(environment))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
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

  if (options.sitemap !== undefined) {
    let site: URL

    try {
      site = new URL(options.sitemap.site)
    } catch {
      throw new TypeError("sitemap.site must be an absolute URL")
    }

    if (site.protocol !== "http:" && site.protocol !== "https:") {
      throw new TypeError("sitemap.site must use http or https")
    }

    if (options.sitemap.lastmod !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}(?:T[^\s]+)?$/.test(options.sitemap.lastmod)) {
        throw new TypeError(
          "sitemap.lastmod must be an ISO 8601 date or datetime",
        )
      }
    }
  }

}

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")

const publicPathForFileName = (
  fileName: string,
  trailingSlash: StaticSiteOptions["trailingSlash"],
): string | undefined => {
  if (fileName === "404.html") {
    return undefined
  }

  if (fileName === "index.html") {
    return "/"
  }

  if (fileName.endsWith("/index.html")) {
    const path = `/${fileName.slice(0, -"index.html".length)}`
    return trailingSlash === "always" ? path : path.slice(0, -1)
  }

  if (fileName.endsWith(".html")) {
    return `/${fileName.slice(0, -".html".length)}`
  }

  return undefined
}

export const createSitemap = (
  routes: ReadonlyArray<{ fileName: string }>,
  options: StaticSiteSitemapOptions,
  trailingSlash: StaticSiteOptions["trailingSlash"],
): string => {
  const site = options.site.replace(/\/+$/, "")
  const lastmod = options.lastmod === undefined ? "" : `<lastmod>${options.lastmod}</lastmod>`
  const urls = routes.flatMap(route => {
    const path = publicPathForFileName(route.fileName, trailingSlash)

    return path === undefined
      ? []
      : [`  <url><loc>${escapeXml(`${site}${path}`)}</loc>${lastmod}</url>`]
  })

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n")
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

  const frontmatter = load(frontmatterSource, { schema: yamlSchema })

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
        !entry.name.endsWith(".satori.tsx") &&
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
  const collections = await loadCollections(options.collections)
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
        `const [Page${index}, Layout${index}] = await Promise.all([import(${JSON.stringify(page.pagePath)}), import(${JSON.stringify(page.layoutPath)})])`,
    )
    .join("\n")
  const componentImports = componentPages
    .map(
      (page, index) =>
        `const ComponentPage${index} = await import(${JSON.stringify(page.pagePath)})`,
    )
    .join("\n")
  const pageRecords = documentPages
    .map(
      (page, index) =>
        `{ Content: Page${index}.default, Layout: Layout${index}.default, fileName: ${JSON.stringify(page.fileName)}, frontmatter: Page${index}.frontmatter, routePath: ${JSON.stringify(page.routePath)} }`,
    )
    .join(",\n")
  const staticComponentRecords = staticComponentPages
    .map(
      ({ index, page }) =>
        `{ Content: ComponentPage${index}.default, fileName: ${JSON.stringify(page.fileName)}, routePath: ${JSON.stringify(page.routePath)}, props: {} }`,
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
  const mdxEntries = Object.entries(collections).flatMap(
    ([collection, entries]) => entries
      .filter(entry => extname(entry.filePath) === ".mdx")
      .map(entry => ({ collection, entry })),
  )
  const collectionImports = mdxEntries
    .map(({ entry }, index) =>
      `const CollectionDocument${index} = await import(${JSON.stringify(entry.filePath)})`,
    )
    .join("\n")
  const collectionDocuments = mdxEntries
    .map(({ collection, entry }, index) =>
      `{ collection: ${JSON.stringify(collection)}, id: ${JSON.stringify(entry.id)}, Content: CollectionDocument${index}.default, headings: CollectionDocument${index}.headings }`,
    )
    .join(",\n")

  return `
import { renderStaticSite, renderMdxCollections } from ${JSON.stringify(rendererPath)}
import { setCollections } from "solid-static/runtime"
import { withRenderEnvironment } from ${JSON.stringify(fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./render-environment.ts" : "./render-environment.js", import.meta.url)))}

export default function generateStaticSite(environment) {
 return withRenderEnvironment(environment, async () => {
  const collections = ${serialize(collectionValues)}
  for (const entries of Object.values(collections)) {
    for (const entry of entries) {
      if (entry.body !== undefined && entry.filePath.endsWith(".md")) {
        entry.rendered = await environment.markdown({ path: entry.filePath, value: entry.body })
      }
    }
  }
  setCollections(collections)
  ${collectionImports}
  await renderMdxCollections(collections, [${collectionDocuments}])
  ${pageImports}
  ${componentImports}

  return renderStaticSite({
    collections,
    documentPages: [${pageRecords}],
    dynamicPages: [${dynamicComponentRecords}],
    staticPages: [${staticComponentRecords}],
    trailingSlash: ${JSON.stringify(options.trailingSlash)},
  })
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

const serveStaticSite = (
  server: ViteDevServer,
  options: ResolvedStaticSiteOptions,
): (() => void) => {
  let routesPromise: Promise<StaticSiteRoute[]> | undefined
  const environment = server.environments.ssr
  if (!environment || !isRunnableDevEnvironment(environment)) {
    throw new TypeError("Static-site development requires Vite's runnable SSR environment")
  }
  const runner = environment.runner

  function createAssets() {
    return createRenderAssets({
      assetsDirectory: server.config.build.assetsDir,
      base: server.config.base,
      devClient: server.config.server.hmr !== false,
      markdownProcessor: options.markdown.processor,
      root: server.config.root,
      styleSheets: () => [...new Set([...environment.moduleGraph.idToModuleMap.values()]
        .map(module => module.url).filter(url => url.endsWith(".css")))].sort().map(url => url.replace(/^\//, "")),
    })
  }
  let assets = createAssets()
  const discoveryRoots = [
    options.pagesDirectory,
    ...Object.values(options.collections).map(collection =>
      resolve(collection.directory),
    ),
  ]

  async function routes(): Promise<StaticSiteRoute[]> {
    routesPromise ??= runner.import(entryId).then(async module => {
      if (!isGeneratedStaticSiteModule(module)) {
        throw new TypeError("Vite loaded an invalid static-site module")
      }

      return requireRoutes(await module.default(assets))
    })

    return routesPromise
  }

  const invalidateRoutes = (): void => {
    routesPromise = undefined
    assets = createAssets()
    const entryModule = environment.moduleGraph.getModuleById(resolvedEntryId)

    if (entryModule !== undefined) {
      environment.moduleGraph.invalidateModule(entryModule)
    }

    runner.clearCache()
    server.environments.client?.hot.send({ type: "full-reload" })
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

  server.watcher.on("add", rediscover)
  server.watcher.on("unlink", rediscover)
  server.watcher.on("change", rediscover)

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

      const requestUrl = new URL(request.url, "http://solid-static.local")
      const assetTarget = assets.redirects.get(requestUrl.pathname)

      if (assetTarget !== undefined) {
        response.statusCode = 302
        response.setHeader("Location", assetTarget)
        response.end()
        return
      }

      const content = assets.files.get(requestUrl.pathname)
      if (content !== undefined) {
        const extension = extname(requestUrl.pathname).slice(1)
        response.statusCode = 200
        response.setHeader("Content-Type", extension === "jpg" || extension === "jpeg" ? "image/jpeg" : `image/${extension}`)
        response.end(request.method === "HEAD" ? undefined : content)
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

      response.statusCode = statusCode
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      response.end(request.method === "HEAD" ? undefined : route.html)
    }

    void handleRequest().catch(error => {
      next(error)
    })
  })

  return invalidateRoutes
}

const staticSitePlugin = (
  unresolved: StaticSiteOptions,
  clientIslands: ClientIslands,
): Plugin => {
  let options = resolveOptions(unresolved, process.cwd())
  let invalidateRoutes = (): void => undefined
  let configuredBase: string | undefined
  let publicBase = "/"
  let assetsDirectory = "assets"

  return {
    name: "solid-static",
    configResolved(config) {
      options = resolveOptions(unresolved, config.root)
      publicBase = configuredBase ?? config.base
      assetsDirectory = config.build.assetsDir
      validateOptions(options)
    },
    config(userConfig, environment) {
      configuredBase = userConfig.base

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
    hotUpdate() {
      if (this.environment.name === "ssr") invalidateRoutes()
    },
    async generateBundle(_outputOptions, bundle) {
      const entry = Object.values(bundle).find(
        output => output.type === "chunk" && output.isEntry,
      )

      if (entry?.type !== "chunk") {
        throw new Error("Vite did not emit the static site's SSR entry")
      }

      const clientBundle = await clientIslands.buildBundle()
      const assets = createRenderAssets({
        assetsDirectory,
        base: publicBase,
        bundle,
        client: clientBundle,
        markdownProcessor: options.markdown.processor,
        root: dirname(dirname(options.pagesDirectory)),
        styleSheets: () => [...(entry.viteMetadata?.importedCss ?? [])].sort(),
        emit: (name, source) => this.getFileName(this.emitFile({ type: "asset", name, source })),
      })
      const routes = await renderGeneratedModule(entry.code, dirname(dirname(options.pagesDirectory)), assets)

      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === "chunk") {
          delete bundle[fileName]
        }
      }

      for (const output of clientBundle.outputs) {
        this.emitFile({
          type: "asset",
          fileName: output.fileName,
          source: output.source,
        })
      }

      const markdownRoutes =
        options.markdownExport === undefined
          ? []
          : await createMarkdownSiblings(routes, options.markdownExport)
      const markdown404Source =
        options.markdownExport?.force404Markdown === true
          ? markdownRoutes.find(route => route.fileName === "404.md")?.source
          : undefined

      for (const route of routes) {
        this.emitFile({
          type: "asset",
          fileName: route.fileName,
          source:
            route.fileName === "404.html" && markdown404Source !== undefined
              ? markdown404Source
              : route.html,
        })
      }

      for (const markdownRoute of markdownRoutes) {
        this.emitFile({
          type: "asset",
          fileName: markdownRoute.fileName,
          source: markdownRoute.source,
        })
      }

      if (options.sitemap !== undefined) {
        this.emitFile({
          type: "asset",
          fileName: "sitemap.xml",
          source: createSitemap(routes, options.sitemap, options.trailingSlash),
        })
      }
    },
  }
}

export const staticSite = (options: StaticSiteOptions): PluginOption => {
  const clientIslands = createClientIslands(options.client)

  return [
    renderJsx(),
    markdownImages(serialize),
    ...options.integrations,
    clientIslands.plugin,
    solid({ ssr: true, hot: false, exclude: /\.satori\.tsx$/ }),
    staticSitePlugin(options, clientIslands),
  ]
}
