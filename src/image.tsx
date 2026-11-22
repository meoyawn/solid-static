import type { JSX } from "@solidjs/web"
import { omit } from "solid-js"
import { getSizesAttribute, type ImageLayout } from "./image-layout.ts"
import { deferred, jsx } from "./jsx-runtime.ts"
import { renderEnvironment } from "./render-environment.ts"

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

export interface ResponsiveImageProps extends JSX.ImgHTMLAttributes<HTMLImageElement> {
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
  const attributes = omit(
    props,
    "decoding",
    "fetchpriority",
    "format",
    "layout",
    "loading",
    "priority",
    "sizes",
    "widths",
  )

  return deferred(async () =>
    jsx("img", {
      ...attributes,
      ...(await renderEnvironment().responsiveImage(props)),
      "data-astro-image":
        props.layout === undefined || props.layout === "none"
          ? undefined
          : props.layout,
      decoding: props.decoding ?? (props.priority ? "sync" : "async"),
      fetchpriority:
        props.fetchpriority ?? (props.priority ? "high" : undefined),
      loading: props.loading ?? (props.priority ? "eager" : "lazy"),
      sizes:
        props.sizes ??
        getSizesAttribute({
          layout: props.layout ?? "none",
          width: props.width,
        }),
    }),
  )
}
