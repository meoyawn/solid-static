import { splitProps, type JSX } from "solid-js"
import { deferred, jsx } from "./jsx-runtime.ts"
import { renderEnvironment } from "./render-environment.ts"
import {
  getSizesAttribute,
  type ImageLayout,
} from "./image-layout.ts"

export {
  getImage,
  type GetImageOptions,
  type GetImageResult,
  type ImageMetadata,
  type ImageOutputFormat,
  type ImageQuality,
  type ImageQualityPreset,
  type ImageTransform,
} from "./get-image.ts"

export interface ResponsiveImageProps
  extends JSX.ImgHTMLAttributes<HTMLImageElement> {
  alt: string
  format?: "avif" | "webp"
  height: number
  layout?: ImageLayout
  priority?: boolean
  sizes?: string
  src: string
  widths?: readonly number[]
  width: number
}

export function ResponsiveImage(props: ResponsiveImageProps): JSX.Element {
  const [local, attributes] = splitProps(props, [
    "decoding", "fetchpriority", "format", "layout", "loading", "priority", "sizes", "widths",
  ])

  return deferred(async () => jsx("img", {
    ...attributes,
    ...await renderEnvironment().responsiveImage(props),
    "data-astro-image": local.layout === undefined || local.layout === "none" ? undefined : local.layout,
    decoding: local.decoding ?? (local.priority ? "sync" : "async"),
    fetchpriority: local.fetchpriority ?? (local.priority ? "high" : undefined),
    loading: local.loading ?? (local.priority ? "eager" : "lazy"),
    sizes: local.sizes ?? getSizesAttribute({ layout: local.layout ?? "none", width: props.width }),
  }))
}
