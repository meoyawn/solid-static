import type { JSX } from "solid-js"

export interface ResponsiveImageProps
  extends JSX.ImgHTMLAttributes<HTMLImageElement> {
  alt: string
  format?: "avif" | "webp"
  height: number
  sizes: string
  src: string
  widths: readonly number[]
  width: number
}

export function ResponsiveImage(props: ResponsiveImageProps): JSX.Element {
  const {
    format = "webp",
    sizes,
    widths,
    ...attributes
  } = props

  return (
    <img
      {...attributes}
      data-vite-static-site-format={format}
      data-vite-static-site-image=""
      data-vite-static-site-sizes={sizes}
      data-vite-static-site-widths={widths.join(",")}
      sizes={sizes}
    />
  )
}
