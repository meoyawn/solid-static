import { readFile } from "node:fs/promises"
import { extname, join } from "node:path"
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite"
import {
  generatedImagePattern,
  parseGeneratedImageRequest,
  type GeneratedImageRequest,
} from "./get-image.ts"
import {
  getWidths,
  type ImageLayout,
} from "./image-layout.ts"
import {
  createImagePipeline,
  imageContentType,
  type ImagePipeline,
  type TransformedImage,
} from "./image-pipeline.ts"

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
  name: string
  url: string
  width: number
}

interface ProcessedImage {
  defaultVariant: ImageVariant
  srcSetVariants: ImageVariant[]
  variants: ImageVariant[]
}

interface EmittedGeneratedImage extends TransformedImage {
  url: string
}

interface ImageSourceAsset {
  fileName: string
  source: string | Uint8Array
  type: "asset"
}

interface GeneratedImageSource {
  content: Uint8Array
  fileName?: string
  name: string
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
  pipeline: ImagePipeline,
  request: ImageRequest,
  urlFor: (name: string) => string,
): Promise<ProcessedImage> => {
  const defaultWidth = Math.min(request.width, pipeline.width)
  const srcSetWidths = [
    ...new Set(
      request.widths ??
        getWidths({
          layout: request.layout,
          originalWidth: pipeline.width,
          width: request.width,
        }),
    ),
  ]
    .filter(width => Number.isInteger(width) && width > 0)
    .filter(width => width <= pipeline.width)
    .sort((left, right) => left - right)
  const outputWidths = [...new Set([defaultWidth, ...srcSetWidths])].sort(
    (left, right) => left - right,
  )
  const variants = await Promise.all(
    outputWidths.map(async width => {
      const image = await pipeline.transform({
        format: request.format,
        width,
      })

      return {
        content: image.content,
        height: image.height,
        name: image.name,
        url: urlFor(image.name),
        width: image.width,
      }
    }),
  )
  const variantsByWidth = new Map(
    variants.map(variant => [variant.width, variant]),
  )
  const defaultVariant = variantsByWidth.get(defaultWidth)

  if (defaultVariant === undefined) {
    throw new TypeError(
      `Responsive image ${pipeline.name} has no default variant`,
    )
  }

  const srcSetVariants: ImageVariant[] = []

  for (const width of srcSetWidths) {
    const variant = variantsByWidth.get(width)

    if (variant === undefined) {
      throw new TypeError(
        `Responsive image ${pipeline.name} is missing ${width}px`,
      )
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

const generatedImageSource = (
  bundle: Record<string, unknown>,
  sourceUrl: string,
): GeneratedImageSource => {
  const dataImage =
    /^data:image\/(?<format>avif|jpeg|jpg|png|svg\+xml|webp);base64,(?<content>.+)$/.exec(
      sourceUrl,
    )

  if (dataImage?.groups?.content !== undefined) {
    const format = dataImage.groups.format

    return {
      content: Buffer.from(dataImage.groups.content, "base64"),
      name: `inline.${format === "svg+xml" ? "svg" : format}`,
    }
  }

  const asset = sourceAsset(bundle, sourceUrl)

  return {
    content: sourceBytes(asset),
    fileName: asset.fileName,
    name: asset.fileName,
  }
}

const devSourcePath = (config: ResolvedConfig, sourceUrl: string): string => {
  const pathname = new URL(sourceUrl, "http://solid-static.local").pathname

  if (!pathname.startsWith("/src/")) {
    throw new TypeError(`Unsupported responsive dev image ${sourceUrl}`)
  }

  return join(config.root, pathname)
}

const replaceGeneratedImages = async (
  html: string,
  process: (request: GeneratedImageRequest) => Promise<EmittedGeneratedImage>,
): Promise<string> => {
  const matches = [...html.matchAll(generatedImagePattern)]
  const operations = new Map<string, Promise<EmittedGeneratedImage>>()

  for (const match of matches) {
    const token = match.groups?.token

    if (token !== undefined && !operations.has(token)) {
      operations.set(token, process(parseGeneratedImageRequest(token)))
    }
  }

  let output = html

  for (const [token, operation] of operations) {
    output = output.replaceAll(
      `/@solid-static/get-image/${token}`,
      (await operation).url,
    )
  }

  return output
}

const publicAssetPath = (base: string, fileName: string): string => {
  const pathBase = base.startsWith("/") ? base : "/"
  return `${pathBase}${fileName}`.replace(/\/{2,}/g, "/")
}

export const responsiveImages = (): Plugin => {
  let config: ResolvedConfig
  let devServer: ViteDevServer | undefined
  const devAssets = new Map<string, Uint8Array>()
  const devPipelines = new Map<string, Promise<ImagePipeline>>()
  const devGeneratedImages = new Map<string, Promise<EmittedGeneratedImage>>()

  function devPipelineFor(sourceUrl: string): Promise<ImagePipeline> {
    const cached = devPipelines.get(sourceUrl)

    if (cached !== undefined) {
      return cached
    }

    const operation = readFile(devSourcePath(config, sourceUrl)).then(source =>
      createImagePipeline(source, sourceUrl),
    )

    devPipelines.set(sourceUrl, operation)
    return operation
  }

  return {
    name: "solid-static-responsive-images",
    configResolved(resolved) {
      config = resolved
    },
    configureServer(server) {
      devServer = server
      server.watcher.on("change", () => {
        devAssets.clear()
        devPipelines.clear()
        devGeneratedImages.clear()
      })
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
        const extension = extname(pathname).slice(1)
        const format = extension === "jpg" ? "jpeg" : extension

        if (
          format !== "avif" &&
          format !== "jpeg" &&
          format !== "png" &&
          format !== "webp"
        ) {
          next()
          return
        }

        response.setHeader("Content-Type", imageContentType(format))
        response.end(content)
      })
    },
    async transformIndexHtml(html) {
      if (devServer === undefined) {
        return html
      }

      const cache = new Map<string, Promise<ProcessedImage>>()
      const withResponsiveImages = await replaceImages(html, request => {
        const key = `${request.sourceUrl}:${request.format}:${request.layout}:${request.width}:${request.widths?.join(",") ?? "auto"}`
        const cached = cache.get(key)

        if (cached !== undefined) {
          return cached
        }

        const operation = devPipelineFor(request.sourceUrl).then(pipeline =>
          processImage(
            pipeline,
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
      return replaceGeneratedImages(withResponsiveImages, request => {
        const key = JSON.stringify(request)
        const cached = devGeneratedImages.get(key)

        if (cached !== undefined) {
          return cached
        }

        const operation = devPipelineFor(request.sourceUrl).then(
          async pipeline => {
            const image = await pipeline.transform(request)
            const url = `/@solid-static/images/${image.name}`

            devAssets.set(url, image.content)
            return {
              content: image.content,
              height: image.height,
              name: image.name,
              url,
              width: image.width,
            }
          },
        )

        devGeneratedImages.set(key, operation)
        return operation
      })
    },
    async generateBundle(_outputOptions, bundle) {
      const cache = new Map<string, Promise<ProcessedImage>>()
      const generatedCache = new Map<string, Promise<EmittedGeneratedImage>>()
      const pipelines = new Map<string, Promise<ImagePipeline>>()
      const transformedImages = new Map<string, TransformedImage>()
      const transformedSourceFiles = new Set<string>()

      function imageFileName(name: string): string {
        const assetsDirectory = config.build.assetsDir.replace(/^\/+|\/+$/g, "")
        return assetsDirectory === "" ? name : `${assetsDirectory}/${name}`
      }

      function imageUrl(name: string): string {
        return publicAssetPath(config.base, imageFileName(name))
      }

      function pipelineFor(
        sourceUrl: string,
        source: GeneratedImageSource,
      ): Promise<ImagePipeline> {
        const cached = pipelines.get(sourceUrl)

        if (cached !== undefined) {
          return cached
        }

        const operation = createImagePipeline(source.content, source.name)

        pipelines.set(sourceUrl, operation)
        return operation
      }

      function registerImage(image: TransformedImage): string {
        transformedImages.set(image.name, image)
        return imageUrl(image.name)
      }

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

          const operation = pipelineFor(request.sourceUrl, {
            content: sourceBytes(asset),
            fileName: asset.fileName,
            name: asset.fileName,
          }).then(pipeline =>
            processImage(pipeline, request, imageUrl).then(image => {
              for (const variant of image.variants) {
                registerImage(variant)
              }
              return image
            }),
          )
          cache.set(key, operation)
          return operation
        })
        output.source = await replaceGeneratedImages(
          output.source.toString(),
          request => {
            const source = generatedImageSource(bundle, request.sourceUrl)

            if (source.fileName !== undefined) {
              transformedSourceFiles.add(source.fileName)
            }

            const key = JSON.stringify(request)
            const cached = generatedCache.get(key)

            if (cached !== undefined) {
              return cached
            }

            const operation = pipelineFor(request.sourceUrl, source).then(
              async pipeline => {
                const image = await pipeline.transform(request)
                return {
                  content: image.content,
                  height: image.height,
                  name: image.name,
                  url: registerImage(image),
                  width: image.width,
                }
              },
            )

            generatedCache.set(key, operation)
            return operation
          },
        )
      }

      for (const image of transformedImages.values()) {
        this.emitFile({
          fileName: imageFileName(image.name),
          source: image.content,
          type: "asset",
        })
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
