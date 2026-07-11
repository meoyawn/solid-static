import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { basename, extname, join } from "node:path"
import sharp from "sharp"
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite"

type ImageFormat = "avif" | "webp"

interface ImageRequest {
  format: ImageFormat
  sizes: string
  sourceUrl: string
  widths: number[]
}

interface ImageVariant {
  content: Uint8Array
  height: number
  url: string
  width: number
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

const imagePattern = /<img(?<attributes>[^>]*\bdata-vite-static-site-image=""[^>]*)>/g

const findAttribute = (attributes: string, name: string): string | undefined =>
  new RegExp(`\\b${name}="(?<value>[^"]*)"`).exec(attributes)?.groups
    ?.value

const parseImageRequest = (attributes: string): ImageRequest => {
  const sourceUrl = findAttribute(attributes, "src")
  const format = findAttribute(attributes, "data-vite-static-site-format")
  const sizes = findAttribute(attributes, "data-vite-static-site-sizes")
  const widths = findAttribute(attributes, "data-vite-static-site-widths")

  if (
    sourceUrl === undefined ||
    sizes === undefined ||
    widths === undefined ||
    (format !== "avif" && format !== "webp")
  ) {
    throw new TypeError("Responsive image is missing required metadata")
  }

  return {
    format,
    sizes,
    sourceUrl,
    widths: widths.split(",").map(width => Number.parseInt(width, 10)),
  }
}

const variantsFor = async (
  source: Uint8Array,
  sourceName: string,
  format: ImageFormat,
  widths: readonly number[],
  urlFor: (name: string) => string,
): Promise<ImageVariant[]> => {
  const metadata = await sharp(source).metadata()
  const originalWidth = metadata.width
  const originalHeight = metadata.height

  if (originalWidth === undefined || originalHeight === undefined) {
    throw new TypeError(`${sourceName} has no dimensions`)
  }

  const baseName = basename(sourceName, extname(sourceName))
  const sourceHash = createHash("sha256").update(source).digest("hex").slice(0, 8)
  const requestedWidths = [...new Set(widths)]
    .filter(width => Number.isInteger(width) && width > 0)
    .filter(width => width <= originalWidth)
    .sort((left, right) => left - right)

  if (requestedWidths.length === 0) {
    throw new TypeError(`${sourceName} has no usable responsive widths`)
  }

  return Promise.all(
    requestedWidths.map(async width => {
      const height = Math.round((originalHeight / originalWidth) * width)
      const name = `${baseName}-${sourceHash}-${width}.${format}`
      const transformer = sharp(source).resize({ height, width })
      const content =
        format === "avif"
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
}

const renderImage = (
  attributes: string,
  request: ImageRequest,
  variants: readonly ImageVariant[],
): string => {
  const defaultVariant = variants.at(-1)

  if (defaultVariant === undefined) {
    throw new TypeError(`Responsive image ${request.sourceUrl} has no variants`)
  }

  const outputAttributes = attributes
    .replace(/\sdata-vite-static-site-(?:image|widths|format|sizes)="[^"]*"/g, "")
    .replace(/\bsrc="[^"]*"/, `src="${defaultVariant.url}"`)
    .replace(/\s*\/$/, "")

  return `<img${outputAttributes} srcset="${variants.map(variant => `${variant.url} ${variant.width}w`).join(", ")}">`
}

const replaceImages = async (
  html: string,
  variants: (request: ImageRequest) => Promise<ImageVariant[]>,
): Promise<string> => {
  const matches = [...html.matchAll(imagePattern)]
  const replacements = await Promise.all(
    matches.map(async match => {
      const attributes = match.groups?.attributes

      if (attributes === undefined) {
        return match[0]
      }

      const request = parseImageRequest(attributes)
      return renderImage(attributes, request, await variants(request))
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
  const pathname = new URL(sourceUrl, "http://vite-static-site.local").pathname

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
    name: "vite-static-site-responsive-images",
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
          "http://vite-static-site.local",
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

      const cache = new Map<string, Promise<ImageVariant[]>>()
      return replaceImages(html, request => {
        const key = `${request.sourceUrl}:${request.format}:${request.widths.join(",")}`
        const cached = cache.get(key)

        if (cached !== undefined) {
          return cached
        }

        const operation = readFile(devSourcePath(config, request.sourceUrl)).then(
          source =>
            variantsFor(
              source,
              request.sourceUrl,
              request.format,
              request.widths,
              name => `/@vite-static-site/images/${name}`,
            ).then(variants => {
              for (const variant of variants) {
                devAssets.set(variant.url, variant.content)
              }
              return variants
            }),
        )
        cache.set(key, operation)
        return operation
      })
    },
    async generateBundle(_outputOptions, bundle) {
      const cache = new Map<string, Promise<ImageVariant[]>>()
      const transformedSourceFiles = new Set<string>()

      for (const output of Object.values(bundle)) {
        if (output.type !== "asset" || !output.fileName.endsWith(".html")) {
          continue
        }

        output.source = await replaceImages(output.source.toString(), request => {
          const asset = sourceAsset(bundle, request.sourceUrl)
          transformedSourceFiles.add(asset.fileName)
          const key = `${asset.fileName}:${request.format}:${request.widths.join(",")}`
          const cached = cache.get(key)

          if (cached !== undefined) {
            return cached
          }

          const operation = variantsFor(
            sourceBytes(asset),
            asset.fileName,
            request.format,
            request.widths,
            name => `/assets/${name}`,
          )
          cache.set(key, operation)
          return operation
        })
      }

      for (const variants of cache.values()) {
        for (const variant of await variants) {
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
