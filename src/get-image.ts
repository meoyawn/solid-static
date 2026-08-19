import { Buffer } from "node:buffer"

export type ImageOutputFormat = "avif" | "jpeg" | "jpg" | "png" | "webp"
export type ImageQualityPreset = "high" | "low" | "max" | "mid"
export type ImageQuality = ImageQualityPreset | number

export interface ImageMetadata {
  format: string
  height: number
  src: string
  width: number
}

export interface GetImageOptions {
  fit?: "contain" | "cover" | "fill" | "inside" | "outside"
  format?: ImageOutputFormat
  height?: number
  position?: string
  quality?: ImageQuality
  src: ImageMetadata | string
  width?: number
}

export interface ImageTransform extends GetImageOptions {
  format: ImageOutputFormat
}

export interface GetImageResult {
  attributes: Record<string, number | string>
  options: ImageTransform
  rawOptions: GetImageOptions
  src: string
  srcSet: {
    attribute: string
    values: Array<{
      attributes?: Record<string, number | string>
      descriptor?: string
      transform: ImageTransform
      url: string
    }>
  }
}

export interface GeneratedImageRequest {
  fit?: GetImageOptions["fit"]
  format: ImageOutputFormat
  height?: number
  position?: string
  quality?: ImageQuality
  sourceUrl: string
  width?: number
}

export const generatedImagePathPrefix = "/@solid-static/get-image/"
export const generatedImagePattern =
  /\/@solid-static\/get-image\/(?<token>[A-Za-z0-9_-]+)/g

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const requireDimension = (
  value: unknown,
  name: "height" | "width",
): number | undefined => {
  if (value === undefined) {
    return undefined
  }

  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    throw new TypeError(`getImage() ${name} must be a positive integer`)
  }

  return value
}

const isImageFormat = (value: unknown): value is ImageOutputFormat =>
  value === "avif" ||
  value === "jpeg" ||
  value === "jpg" ||
  value === "png" ||
  value === "webp"

const isImageQuality = (value: unknown): value is ImageQuality =>
  value === "high" ||
  value === "low" ||
  value === "max" ||
  value === "mid" ||
  (typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 100)

const sourceMetadata = (
  source: ImageMetadata | string,
): ImageMetadata | undefined =>
  typeof source === "string" ? undefined : source

const sourceUrl = (source: ImageMetadata | string): string =>
  typeof source === "string" ? source : source.src

const inferDimensions = (
  metadata: ImageMetadata | undefined,
  width: number | undefined,
  height: number | undefined,
): { height?: number; width?: number } => {
  if (metadata === undefined) {
    return {
      ...(height === undefined ? {} : { height }),
      ...(width === undefined ? {} : { width }),
    }
  }

  if (width !== undefined && height === undefined) {
    return {
      height: Math.round((metadata.height / metadata.width) * width),
      width,
    }
  }

  if (height !== undefined && width === undefined) {
    return {
      height,
      width: Math.round((metadata.width / metadata.height) * height),
    }
  }

  return {
    height: height ?? metadata.height,
    width: width ?? metadata.width,
  }
}

const encodeRequest = (request: GeneratedImageRequest): string =>
  Buffer.from(JSON.stringify(request)).toString("base64url")

export const parseGeneratedImageRequest = (
  token: string,
): GeneratedImageRequest => {
  let value: unknown

  try {
    value = JSON.parse(Buffer.from(token, "base64url").toString())
  } catch {
    throw new TypeError("Invalid getImage() request")
  }

  if (
    !isRecord(value) ||
    typeof value.sourceUrl !== "string" ||
    value.sourceUrl === "" ||
    !isImageFormat(value.format) ||
    (value.fit !== undefined &&
      value.fit !== "contain" &&
      value.fit !== "cover" &&
      value.fit !== "fill" &&
      value.fit !== "inside" &&
      value.fit !== "outside") ||
    (value.position !== undefined && typeof value.position !== "string") ||
    (value.quality !== undefined && !isImageQuality(value.quality))
  ) {
    throw new TypeError("Invalid getImage() request")
  }

  const width = requireDimension(value.width, "width")
  const height = requireDimension(value.height, "height")

  return {
    format: value.format,
    sourceUrl: value.sourceUrl,
    ...(value.fit === undefined ? {} : { fit: value.fit }),
    ...(height === undefined ? {} : { height }),
    ...(value.position === undefined ? {} : { position: value.position }),
    ...(value.quality === undefined ? {} : { quality: value.quality }),
    ...(width === undefined ? {} : { width }),
  }
}

export const getImage = async (
  rawOptions: GetImageOptions,
): Promise<GetImageResult> => {
  if (typeof document !== "undefined") {
    throw new TypeError("getImage() is only available during server rendering")
  }

  const format = rawOptions.format ?? "webp"

  if (!isImageFormat(format)) {
    throw new TypeError(`Unsupported getImage() format ${format}`)
  }

  if (
    rawOptions.quality !== undefined &&
    !isImageQuality(rawOptions.quality)
  ) {
    throw new TypeError("getImage() quality must be 0-100 or a quality preset")
  }

  const width = requireDimension(rawOptions.width, "width")
  const height = requireDimension(rawOptions.height, "height")
  const dimensions = inferDimensions(
    sourceMetadata(rawOptions.src),
    width,
    height,
  )
  const request: GeneratedImageRequest = {
    format,
    sourceUrl: sourceUrl(rawOptions.src),
    ...(rawOptions.fit === undefined ? {} : { fit: rawOptions.fit }),
    ...(dimensions.height === undefined ? {} : { height: dimensions.height }),
    ...(rawOptions.position === undefined
      ? {}
      : { position: rawOptions.position }),
    ...(rawOptions.quality === undefined
      ? {}
      : { quality: rawOptions.quality }),
    ...(dimensions.width === undefined ? {} : { width: dimensions.width }),
  }
  const options: ImageTransform = {
    ...rawOptions,
    format,
    ...(dimensions.height === undefined ? {} : { height: dimensions.height }),
    ...(dimensions.width === undefined ? {} : { width: dimensions.width }),
  }
  const attributes: Record<string, number | string> = {}

  if (dimensions.width !== undefined) {
    attributes.width = dimensions.width
  }

  if (dimensions.height !== undefined) {
    attributes.height = dimensions.height
  }

  return {
    attributes,
    options,
    rawOptions,
    src: `${generatedImagePathPrefix}${encodeRequest(request)}`,
    srcSet: { attribute: "", values: [] },
  }
}
