import { createHash } from "node:crypto"
import { basename, extname } from "node:path"
import sharp from "sharp"
import type {
  GetImageOptions,
  ImageOutputFormat,
  ImageQuality,
} from "./get-image.ts"

export interface ImagePipelineTransform {
  fit?: GetImageOptions["fit"]
  format: ImageOutputFormat
  height?: number
  position?: string
  quality?: ImageQuality
  width?: number
}

export interface TransformedImage {
  content: Uint8Array
  height: number
  name: string
  width: number
}

export interface ImagePipeline {
  height: number
  name: string
  transform: (request: ImagePipelineTransform) => Promise<TransformedImage>
  width: number
}

interface ResolvedImageTransform {
  fit: NonNullable<ImagePipelineTransform["fit"]>
  format: ImageOutputFormat
  height: number
  position: string
  quality: number | undefined
  width: number
}

const qualityValue = (quality: ImageQuality | undefined): number | undefined => {
  if (typeof quality === "number" || quality === undefined) {
    return quality
  }

  return {
    high: 80,
    low: 25,
    max: 100,
    mid: 50,
  }[quality]
}

const resolveTransform = (
  request: ImagePipelineTransform,
  originalWidth: number,
  originalHeight: number,
): ResolvedImageTransform => {
  const width =
    request.width ??
    (request.height === undefined
      ? originalWidth
      : Math.round((originalWidth / originalHeight) * request.height))
  const height =
    request.height ?? Math.round((originalHeight / originalWidth) * width)

  return {
    fit: request.fit ?? "cover",
    format: request.format === "jpeg" ? "jpg" : request.format,
    height,
    position: request.position ?? "center",
    quality: qualityValue(request.quality),
    width,
  }
}

const imageExtension = (format: ImageOutputFormat): string =>
  format === "jpeg" ? "jpg" : format

export const imageContentType = (format: ImageOutputFormat): string => {
  if (format === "jpg" || format === "jpeg") {
    return "image/jpeg"
  }

  return `image/${format}`
}

export const createImagePipeline = async (
  source: Uint8Array,
  sourceName: string,
): Promise<ImagePipeline> => {
  const metadata = await sharp(source).metadata()
  const originalWidth = metadata.width
  const originalHeight = metadata.height

  if (originalWidth === undefined || originalHeight === undefined) {
    throw new TypeError(`${sourceName} has no dimensions`)
  }

  const baseName = basename(sourceName, extname(sourceName))
  const sourceHash = createHash("sha256").update(source).digest("hex").slice(0, 8)
  const transforms = new Map<string, Promise<TransformedImage>>()

  function transform(
    request: ImagePipelineTransform,
  ): Promise<TransformedImage> {
    const resolved = resolveTransform(request, originalWidth, originalHeight)
    const key = JSON.stringify(resolved)
    const cached = transforms.get(key)

    if (cached !== undefined) {
      return cached
    }

    async function process(): Promise<TransformedImage> {
      const transformer = sharp(source).resize({
        fit: resolved.fit,
        height: resolved.height,
        position: resolved.position,
        width: resolved.width,
      })
      let content: Buffer

      if (resolved.format === "avif") {
        content = await transformer.avif({ quality: resolved.quality }).toBuffer()
      } else if (resolved.format === "jpg") {
        content = await transformer.jpeg({ quality: resolved.quality }).toBuffer()
      } else if (resolved.format === "png") {
        content = await transformer.png({ quality: resolved.quality }).toBuffer()
      } else {
        content = await transformer.webp({ quality: resolved.quality }).toBuffer()
      }

      const transformHash = createHash("sha256")
        .update(key)
        .digest("hex")
        .slice(0, 8)

      return {
        content,
        height: resolved.height,
        name: `${baseName}-${sourceHash}-${transformHash}.${imageExtension(resolved.format)}`,
        width: resolved.width,
      }
    }

    const operation = process()

    transforms.set(key, operation)
    return operation
  }

  return {
    height: originalHeight,
    name: sourceName,
    transform,
    width: originalWidth,
  }
}
