export type ImageLayout = "constrained" | "fixed" | "full-width" | "none"

export const limitedResolutions = [
  640,
  750,
  828,
  1080,
  1280,
  1668,
  2048,
  2560,
]

export const getWidths = ({
  breakpoints = limitedResolutions,
  layout,
  originalWidth,
  width,
}: {
  breakpoints?: number[]
  layout: ImageLayout
  originalWidth?: number
  width?: number
}): number[] => {
  const smallerThanOriginal = (candidate: number): boolean =>
    originalWidth === undefined || candidate <= originalWidth

  if (layout === "full-width") {
    return breakpoints.filter(smallerThanOriginal)
  }

  if (width === undefined) {
    return []
  }

  const doubleWidth = width * 2
  const maxSize =
    originalWidth === undefined
      ? doubleWidth
      : Math.min(doubleWidth, originalWidth)

  if (layout === "fixed") {
    return originalWidth !== undefined && width > originalWidth
      ? [originalWidth]
      : [width, maxSize]
  }

  if (layout === "constrained") {
    return [width, doubleWidth, ...breakpoints]
      .filter(candidate => candidate <= maxSize)
      .sort((left, right) => left - right)
  }

  return []
}

export const getSizesAttribute = ({
  layout,
  width,
}: {
  layout?: ImageLayout
  width?: number
}): string | undefined => {
  if (layout === undefined || width === undefined) {
    return undefined
  }

  if (layout === "constrained") {
    return `(min-width: ${width}px) ${width}px, 100vw`
  }

  if (layout === "fixed") {
    return `${width}px`
  }

  if (layout === "full-width") {
    return "100vw"
  }

  return undefined
}
