import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { basename, extname, join } from "node:path"
import sharp from "sharp"
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite"
import {
  getWidths,
  type ImageLayout,
} from "./image-layout.ts"

type ImageFormat = "avif" | "webp"

interface ImageRequest {
  format: ImageFormat
  layout: ImageLayout
  sourceUrl: string
  width: number
  widths?: number[]
}

interface ImageVariant {
  content: Uint8Array
  height: number
  url: string
  width: number
}

interface ProcessedImage {
  defaultVariant: ImageVariant
  srcSetVariants: ImageVariant[]
  variants: ImageVariant[]
}

interface ImageSourceAsset {
  fileName: string
  source: string | Uint8Array
  type: "asset"
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isImageSourceAsset = (value: unknown): value is ImageSourceAsset =>
  isRecord(value) &&
  value.type === "asset" &&
  typeof value.fileName === "string" &&
  (typeof value.source === "string" || value.source instanceof Uint8Array)

const imagePattern = /<img(?<attributes>[^>]*\bdata-solid-static-image=""[^>]*)>/g

const findAttribute = (attributes: string, name: string): string | undefined =>
  new RegExp(`\\b${name}="(?<value>[^"]*)"`).exec(attributes)?.groups
    ?.value

const isImageLayout = (value: string | undefined): value is ImageLayout =>
  value === "constrained" ||
  value === "fixed" ||
  value === "full-width" ||
  value === "none"

const parseImageRequest = (attributes: string): ImageRequest => {
  const sourceUrl = findAttribute(attributes, "src")
  const format = findAttribute(attributes, "data-solid-static-format")
  const layout = findAttribute(attributes, "data-solid-static-layout")
  const widthValue = findAttribute(attributes, "width")
  const widths = findAttribute(attributes, "data-solid-static-widths")

  if (
    sourceUrl === undefined ||
    !isImageLayout(layout) ||
    widthValue === undefined ||
    (format !== "avif" && format !== "webp")
  ) {
    throw new TypeError("Responsive image is missing required metadata")
  }

  const width = Number.parseInt(widthValue, 10)

  if (!Number.isInteger(width) || width <= 0) {
    throw new TypeError("Responsive image width must be a positive integer")
  }

  const request: ImageRequest = {
    format,
    layout,
    sourceUrl,
    width,
  }

  if (widths !== undefined) {
    request.widths = widths
      .split(",")
      .map(candidate => Number.parseInt(candidate, 10))
  }

  return request
}

const processImage = async (
  source: Uint8Array,
  sourceName: string,
  request: ImageRequest,
  urlFor: (name: string) => string,
): Promise<ProcessedImage> => {
  const metadata = await sharp(source).metadata()
  const originalWidth = metadata.width
  const originalHeight = metadata.height

  if (originalWidth === undefined || originalHeight === undefined) {
    throw new TypeError(`${sourceName} has no dimensions`)
  }

  const baseName = basename(sourceName, extname(sourceName))
  const sourceHash = createHash("sha256").update(source).digest("hex").slice(0, 8)
  const defaultWidth = Math.min(request.width, originalWidth)
  const srcSetWidths = [
    ...new Set(
      request.widths ??
        getWidths({
          layout: request.layout,
          originalWidth,
          width: request.width,
        }),
    ),
  ]
    .filter(width => Number.isInteger(width) && width > 0)
    .filter(width => width <= originalWidth)
    .sort((left, right) => left - right)
  const outputWidths = [...new Set([defaultWidth, ...srcSetWidths])].sort(
    (left, right) => left - right,
  )
  const variants = await Promise.all(
    outputWidths.map(async width => {
      const height = Math.round((originalHeight / originalWidth) * width)
      const name = `${baseName}-${sourceHash}-${width}.${request.format}`
      const transformer = sharp(source).resize({ height, width })
      const content =
        request.format === "avif"
          ? await transformer.avif().toBuffer()
          : await transformer.webp().toBuffer()

      return {
        content,
        height,
        url: urlFor(name),
        width,
      }
    }),
  )
  const variantsByWidth = new Map(
    variants.map(variant => [variant.width, variant]),
  )
  const defaultVariant = variantsByWidth.get(defaultWidth)

  if (defaultVariant === undefined) {
    throw new TypeError(`Responsive image ${sourceName} has no default variant`)
  }

  const srcSetVariants: ImageVariant[] = []

  for (const width of srcSetWidths) {
    const variant = variantsByWidth.get(width)

    if (variant === undefined) {
      throw new TypeError(`Responsive image ${sourceName} is missing ${width}px`)
    }

    srcSetVariants.push(variant)
  }

  return { defaultVariant, srcSetVariants, variants }
}

const renderImage = (
  attributes: string,
  image: ProcessedImage,
): string => {
  const outputAttributes = attributes
    .replace(/\sdata-solid-static-(?:image|widths|format|layout|sizes)="[^"]*"/g, "")
    .replace(/\s+srcset="[^"]*"/g, "")
    .replace(/\bsrc="[^"]*"/, `src="${image.defaultVariant.url}"`)
    .replace(/\s*\/$/, "")
  const srcSet = image.srcSetVariants
    .map(variant => `${variant.url} ${variant.width}w`)
    .join(", ")
  const srcSetAttribute = srcSet === "" ? "" : ` srcset="${srcSet}"`

  return `<img${outputAttributes}${srcSetAttribute}>`
}

const replaceImages = async (
  html: string,
  process: (request: ImageRequest) => Promise<ProcessedImage>,
): Promise<string> => {
  const matches = [...html.matchAll(imagePattern)]
  const replacements = await Promise.all(
    matches.map(async match => {
      const attributes = match.groups?.attributes

      if (attributes === undefined) {
        return match[0]
      }

      const request = parseImageRequest(attributes)
      return renderImage(attributes, await process(request))
    }),
  )

  return replacements.reduce(
    (output, replacement, index) =>
      output.replace(matches[index]?.[0] ?? "", replacement),
    html,
  )
}

const sourceAsset = (
  bundle: Record<string, unknown>,
  sourceUrl: string,
): ImageSourceAsset => {
  const fileName = sourceUrl.replace(/^\//, "")
  const asset = bundle[fileName]

  if (!isImageSourceAsset(asset)) {
    throw new TypeError(`Unable to find responsive image source ${sourceUrl}`)
  }

  return asset
}

const sourceBytes = (asset: ImageSourceAsset): Uint8Array =>
  asset.source instanceof Uint8Array
    ? asset.source
    : Buffer.from(asset.source)

const devSourcePath = (config: ResolvedConfig, sourceUrl: string): string => {
  const pathname = new URL(sourceUrl, "http://solid-static.local").pathname

  if (!pathname.startsWith("/src/")) {
    throw new TypeError(`Unsupported responsive dev image ${sourceUrl}`)
  }

  return join(config.root, pathname)
}

export const responsiveImages = (): Plugin => {
  let config: ResolvedConfig
  let devServer: ViteDevServer | undefined
  const devAssets = new Map<string, Uint8Array>()

  return {
    name: "solid-static-responsive-images",
    configResolved(resolved) {
      config = resolved
    },
    configureServer(server) {
      devServer = server
      server.middlewares.use(function responsiveImageMiddleware(
        request,
        response,
        next,
      ) {
        const pathname = new URL(
          request.url ?? "/",
          "http://solid-static.local",
        ).pathname
        const content = devAssets.get(pathname)

        if (content === undefined) {
          next()
          return
        }

        response.statusCode = 200
        response.setHeader(
          "Content-Type",
          pathname.endsWith(".avif") ? "image/avif" : "image/webp",
        )
        response.end(content)
      })
    },
    async transformIndexHtml(html) {
      if (devServer === undefined) {
        return html
      }

      const cache = new Map<string, Promise<ProcessedImage>>()
      return replaceImages(html, request => {
        const key = `${request.sourceUrl}:${request.format}:${request.layout}:${request.width}:${request.widths?.join(",") ?? "auto"}`
        const cached = cache.get(key)

        if (cached !== undefined) {
          return cached
        }

        const operation = readFile(devSourcePath(config, request.sourceUrl)).then(
          source =>
            processImage(
              source,
              request.sourceUrl,
              request,
              name => `/@solid-static/images/${name}`,
            ).then(image => {
              for (const variant of image.variants) {
                devAssets.set(variant.url, variant.content)
              }
              return image
            }),
        )
        cache.set(key, operation)
        return operation
      })
    },
    async generateBundle(_outputOptions, bundle) {
      const cache = new Map<string, Promise<ProcessedImage>>()
      const transformedSourceFiles = new Set<string>()

      for (const output of Object.values(bundle)) {
        if (output.type !== "asset" || !output.fileName.endsWith(".html")) {
          continue
        }

        output.source = await replaceImages(output.source.toString(), request => {
          const asset = sourceAsset(bundle, request.sourceUrl)
          transformedSourceFiles.add(asset.fileName)
          const key = `${asset.fileName}:${request.format}:${request.layout}:${request.width}:${request.widths?.join(",") ?? "auto"}`
          const cached = cache.get(key)

          if (cached !== undefined) {
            return cached
          }

          const operation = processImage(
            sourceBytes(asset),
            asset.fileName,
            request,
            name => `/assets/${name}`,
          )
          cache.set(key, operation)
          return operation
        })
      }

      for (const operation of cache.values()) {
        for (const variant of (await operation).variants) {
          this.emitFile({
            fileName: variant.url.replace(/^\//, ""),
            source: variant.content,
            type: "asset",
          })
        }
      }

      for (const fileName of transformedSourceFiles) {
        const remainsReferenced = Object.values(bundle).some(
          output =>
            output.type === "asset" &&
            output.fileName !== fileName &&
            output.source.toString().includes(`/${fileName}`),
        )

        if (!remainsReferenced) {
          delete bundle[fileName]
        }
      }
    },
  }
}
