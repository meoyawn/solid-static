import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { basename, dirname, extname, join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Element, Root, RootContent } from "hast"
import satori from "satori"
import sharp from "sharp"
import type { ClientIslandBundle } from "./client-islands.ts"
import type { GeneratedImageRequest, ImageMetadata } from "./get-image.ts"
import type { ResponsiveImageProps } from "./image.tsx"
import { getWidths } from "./image-layout.ts"
import { createImagePipeline, type ImagePipeline } from "./image-pipeline.ts"
import type { RenderEnvironment } from "./render-environment.ts"
import type { SatoriImageOptions } from "./satori.ts"
import { compileMarkdown, type MarkdownProcessor, type RenderedMarkdown } from "./content.ts"
import { htmlForTree } from "./render-tree.ts"

interface SourceAsset {
  content: Uint8Array
  name: string
}

export interface RenderAssetsOptions {
  assetsDirectory: string
  base: string
  bundle?: Record<string, unknown>
  client?: ClientIslandBundle
  devClient?: boolean
  emit?: (name: string, content: Uint8Array) => string
  root: string
  markdownProcessor: MarkdownProcessor
  styleSheets: () => string[]
}

export interface RenderAssets extends RenderEnvironment {
  files: Map<string, Uint8Array>
  redirects: Map<string, string>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function assetUrl(base: string, fileName: string, routeFileName = "index.html"): string {
  if (base === "" || base.startsWith(".")) {
    const path = relative(dirname(routeFileName), fileName).replaceAll("\\", "/")
    return encodeURI(path.startsWith(".") ? path : `./${path}`).replaceAll("#", "%23").replaceAll("?", "%3F")
  }
  return `${base.endsWith("/") ? base : `${base}/`}${encodeURI(fileName).replaceAll("#", "%23").replaceAll("?", "%3F")}`
}

export function createRenderAssets(options: RenderAssetsOptions): RenderAssets {
  const files = new Map<string, Uint8Array>()
  const redirects = new Map<string, string>()
  const pipelines = new Map<string, Promise<ImagePipeline>>()
  const artifacts = new Map<string, string>()
  const islandUrls = new Map<string, { fileName: string; styles: string[] }>()
  const assetFiles = new Map<string, string>()
  const imageCandidates = new Map<string, { src: string; width: number }[]>()
  const socialImages = new Map<string, Promise<ImageMetadata>>()

  for (const output of Object.values(options.bundle ?? {})) {
    if (isRecord(output) && output.type === "asset" && typeof output.fileName === "string") {
      assetFiles.set(assetUrl(options.base, output.fileName), output.fileName)
    }
  }

  function register(name: string, content: Uint8Array): string {
    const key = `${name}:${createHash("sha256").update(content).digest("hex")}`
    const existing = artifacts.get(key)
    if (existing !== undefined) return existing
    const fileName = options.emit?.(name, content) ?? join(options.assetsDirectory, name).replaceAll("\\", "/")
    const url = assetUrl(options.base, fileName)
    files.set(new URL(url, "http://solid-static.local").pathname, content)
    assetFiles.set(url, fileName)
    artifacts.set(key, url)
    return url
  }

  async function sourceFor(sourceUrl: string): Promise<SourceAsset> {
    if (sourceUrl.startsWith("data:")) {
      const match = /^data:(?<type>[^;,]+)(?<base64>;base64)?,(?<data>[\s\S]*)$/.exec(sourceUrl)
      if (match?.groups?.data === undefined) throw new TypeError("Invalid inline image source")
      const extension = match.groups.type?.split("/")[1]?.replace("svg+xml", "svg") ?? "bin"
      return {
        content: match.groups.base64 === undefined
          ? Buffer.from(decodeURIComponent(match.groups.data))
          : Buffer.from(match.groups.data, "base64"),
        name: `inline.${extension}`,
      }
    }
    if (sourceUrl.startsWith("file:")) {
      return { content: await readFile(new URL(sourceUrl)), name: basename(fileURLToPath(sourceUrl)) }
    }
    if (options.bundle !== undefined) {
      const pathname = new URL(sourceUrl, "http://solid-static.local").pathname
      const basePath = new URL(options.base || "/", "http://solid-static.local/").pathname
      const fileName = decodeURIComponent(pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname.replace(/^\//, ""))
      const output = options.bundle[fileName]
      if (!isRecord(output) || output.type !== "asset" || (typeof output.source !== "string" && !(output.source instanceof Uint8Array))) {
        throw new TypeError(`Unable to find static image or font source ${sourceUrl}`)
      }
      const names = Array.isArray(output.originalFileNames) ? output.originalFileNames : output.names
      const name = Array.isArray(names) && typeof names[0] === "string" ? basename(names[0]) : basename(fileName)
      return { content: typeof output.source === "string" ? Buffer.from(output.source) : output.source, name }
    }
    const pathname = decodeURIComponent(new URL(sourceUrl, "http://solid-static.local").pathname)
    const basePath = new URL(options.base || "/", "http://solid-static.local").pathname
    const path = pathname.startsWith(basePath) ? `/${pathname.slice(basePath.length)}` : pathname
    const fileName = path.startsWith("/@fs/") ? path.slice("/@fs".length) : join(options.root, path)
    return { content: await readFile(fileName), name: basename(fileName) }
  }

  async function pipelineFor(sourceUrl: string): Promise<ImagePipeline> {
    const source = await sourceFor(sourceUrl)
    const key = `${source.name}:${createHash("sha256").update(source.content).digest("hex")}`
    let pipeline = pipelines.get(key)
    if (pipeline === undefined) {
      pipeline = createImagePipeline(source.content, source.name)
      pipelines.set(key, pipeline)
    }
    return pipeline
  }

  async function image(request: GeneratedImageRequest): Promise<ImageMetadata> {
    const pipeline = await pipelineFor(request.sourceUrl)
    const result = await pipeline.transform(request)
    return {
      format: request.format,
      height: result.height,
      src: register(result.name, result.content),
      width: result.width,
    }
  }

  async function responsiveImage(props: ResponsiveImageProps): Promise<Record<string, unknown>> {
    if (!Number.isInteger(props.width) || props.width <= 0 || !Number.isInteger(props.height) || props.height <= 0) {
      throw new TypeError("Responsive image dimensions must be positive integers")
    }
    const pipeline = await pipelineFor(props.src)
    const width = Math.min(props.width, pipeline.width)
    const widths = [...new Set(props.widths ?? getWidths({
      layout: props.layout ?? "none", originalWidth: pipeline.width, width: props.width,
    }))].filter(value => Number.isInteger(value) && value > 0 && value <= pipeline.width).sort((left, right) => left - right)
    const variants = new Map(await Promise.all([...new Set([width, ...widths])].map(async value => {
      const result = await pipeline.transform({ format: props.format ?? "webp", width: value })
      return [value, register(result.name, result.content)] as const
    })))
    const candidates = widths.map(value => {
      const src = variants.get(value)
      if (src === undefined) throw new TypeError(`Missing responsive image variant ${value}`)
      return { src, width: value }
    })
    const srcset = candidates.map(candidate => `${candidate.src} ${candidate.width}w`).join(", ")
    imageCandidates.set(srcset, candidates)
    return { src: variants.get(width), ...(candidates.length === 0 ? {} : { srcset }) }
  }

  function satoriImage(options_: SatoriImageOptions): Promise<ImageMetadata> {
    const key = JSON.stringify(options_)
    const cached = socialImages.get(key)
    if (cached !== undefined) return cached
    async function render(): Promise<ImageMetadata> {
      const fonts = await Promise.all(options_.fonts.map(async font => ({
        name: font.name,
        data: Buffer.from((await sourceFor(font.src)).content),
        weight: font.weight,
        style: font.style ?? ("normal" as const),
      })))
      const svg = await satori(options_.element, { fonts, height: options_.height, width: options_.width })
      const content = await sharp(Buffer.from(svg)).png().toBuffer()
      const hash = createHash("sha256").update(content).digest("hex").slice(0, 16)
      return {
        format: "png", height: options_.height, width: options_.width,
        src: register(`social-${hash}.png`, content),
      }
    }
    const operation = render()
    socialImages.set(key, operation)
    return operation
  }

  function islandUrl(key: string): string {
    const fileName = options.client?.entryFiles.get(key)
    if (fileName === undefined || options.client === undefined) throw new TypeError(`Unknown client island ${key}`)
    const url = assetUrl(options.client.base, fileName)
    islandUrls.set(url, { fileName, styles: options.client.styleFilesByEntry.get(key) ?? [] })
    return url
  }

  async function prepareMarkdown(tree: Root, sourcePath: string): Promise<Root> {
    async function visit(nodes: RootContent[]): Promise<void> {
      for (const node of nodes) {
        if (node.type !== "element") continue
        const source = node.properties.src
        if (node.tagName === "img" && typeof source === "string" && !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(source)) {
          const sourceUrl = new URL(source, pathToFileURL(sourcePath)).href
          const original = await sourceFor(sourceUrl)
          const pipeline = await pipelineFor(sourceUrl)
          const originalUrl = register(original.name, original.content)
          const attributes = await responsiveImage({
            alt: typeof node.properties.alt === "string" ? node.properties.alt : "",
            height: pipeline.height, width: pipeline.width, layout: "constrained", src: sourceUrl,
          })
          node.properties = { ...node.properties, ...attributes, height: pipeline.height, width: pipeline.width, loading: "lazy", decoding: "async" }
          node.data = { ...node.data, originalImageUrl: originalUrl }
        }
        await visit(node.children)
      }
    }
    await visit(tree.children)
    return tree
  }

  async function prepareDocument(tree: Root, routeFileName: string): Promise<Root> {
    const styles = new Set(options.styleSheets().map(fileName => assetUrl(options.base, fileName, routeFileName || "index.html")))
    const authoredStyles = new Set<string>()
    let head: Element | undefined

    function resolveUrl(value: string): string {
      const island = islandUrls.get(value)
      if (island !== undefined && options.client !== undefined) {
        for (const style of island.styles) styles.add(assetUrl(options.client.base, style, routeFileName || "index.html"))
        return assetUrl(options.client.base, island.fileName, routeFileName || "index.html")
      }
      const fileName = assetFiles.get(value)
      if (fileName !== undefined) return assetUrl(options.base, fileName, routeFileName || "index.html")
      if (options.bundle === undefined && value.startsWith("/") && value.includes("no-inline")) {
        const url = new URL(value, "http://solid-static.local")
        const extension = extname(url.pathname)
        const name = basename(url.pathname, extension)
        const hash = createHash("sha256").update(value).digest("hex").slice(0, 8)
        const publicPath = `/assets/${name}-${hash}${extension}`
        redirects.set(publicPath, value)
        return publicPath
      }
      return value
    }

    function visit(nodes: RootContent[]): void {
      for (const node of nodes) {
        if (node.type !== "element") continue
        if (node.tagName === "head") head = node
        for (const attribute of ["href", "src", "poster"]) {
          const value = node.properties[attribute]
          if (typeof value === "string") node.properties[attribute] = resolveUrl(value)
        }
        for (const attribute of ["srcset", "srcSet"]) {
          const value = node.properties[attribute]
          const candidates = typeof value === "string" ? imageCandidates.get(value) : undefined
          if (candidates !== undefined) {
            node.properties[attribute] = candidates.map(candidate => `${resolveUrl(candidate.src)} ${candidate.width}w`).join(", ")
          }
        }
        if (node.tagName === "link" && String(node.properties.rel).split(/\s+/).includes("stylesheet") && typeof node.properties.href === "string") {
          authoredStyles.add(node.properties.href)
        }
        visit(node.children)
      }
    }
    visit(tree.children)
    if (routeFileName === "") return tree
    if (head === undefined && styles.size > 0) throw new TypeError("Static-site route has no head element for its stylesheets")
    for (const href of styles) {
      if (!authoredStyles.has(href)) head?.children.push({ type: "element", tagName: "link", properties: { rel: ["stylesheet"], href }, children: [] })
    }
    if (options.devClient) {
      head?.children.push({ type: "element", tagName: "script", properties: { type: "module", src: `${options.base.replace(/\/$/, "")}/@vite/client` }, children: [] })
    }
    return tree
  }

  async function markdown(file: { path: string; value: string }): Promise<RenderedMarkdown> {
    const result = await compileMarkdown(options.markdownProcessor, file)
    const tree = await prepareMarkdown(result.tree, file.path)
    return { tree, html: htmlForTree(tree), headings: result.headings }
  }

  return { files, redirects, image, responsiveImage, satoriImage, islandUrl, prepareMarkdown, prepareDocument, markdown }
}
