import type { JSX } from "solid-js"
import {
  getSizesAttribute,
  type ImageLayout,
} from "./image-layout.ts"

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
  const {
    decoding,
    fetchpriority,
    format = "webp",
    layout = "none",
    loading,
    priority = false,
    sizes,
    widths,
    ...attributes
  } = props
  const resolvedSizes =
    sizes ?? getSizesAttribute({ layout, width: attributes.width })

  return (
    <img
      {...attributes}
      data-astro-image={layout === "none" ? undefined : layout}
      data-solid-static-format={format}
      data-solid-static-image=""
      data-solid-static-layout={layout}
      data-solid-static-sizes={resolvedSizes}
      data-solid-static-widths={widths?.join(",")}
      decoding={decoding ?? (priority ? "sync" : "async")}
      fetchpriority={fetchpriority ?? (priority ? "high" : undefined)}
      loading={loading ?? (priority ? "eager" : "lazy")}
      sizes={resolvedSizes}
    />
  )
}
