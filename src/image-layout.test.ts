import { describe, expect, test } from "vitest"
import {
  getSizesAttribute,
  getWidths,
  limitedResolutions,
} from "./image-layout.ts"

describe("getWidths", () => {
  test("uses every supported full-width breakpoint below the source width", () => {
    expect(
      getWidths({
        layout: "full-width",
        originalWidth: 2316,
      }),
    ).toEqual([640, 750, 828, 1080, 1280, 1668, 2048])
  })

  test("uses 1x and 2x for fixed images", () => {
    expect(
      getWidths({
        layout: "fixed",
        originalWidth: 2316,
        width: 800,
      }),
    ).toEqual([800, 1600])
  })

  test("caps fixed images at the source width", () => {
    expect(
      getWidths({
        layout: "fixed",
        originalWidth: 1200,
        width: 800,
      }),
    ).toEqual([800, 1200])
  })

  test("uses breakpoints through 2x for constrained images", () => {
    expect(
      getWidths({
        layout: "constrained",
        originalWidth: 2316,
        width: 800,
      }),
    ).toEqual([640, 750, 800, 828, 1080, 1280, 1600])
  })

  test("does not generate srcset widths for none layout", () => {
    expect(
      getWidths({
        layout: "none",
        originalWidth: 2316,
        width: 800,
      }),
    ).toEqual([])
  })

  test("uses all breakpoints for a full-width remote image", () => {
    expect(getWidths({ layout: "full-width" })).toEqual(limitedResolutions)
  })
})

describe("getSizesAttribute", () => {
  test.each([
    ["constrained", "(min-width: 800px) 800px, 100vw"],
    ["fixed", "800px"],
    ["full-width", "100vw"],
    ["none", undefined],
  ] as const)("matches Astro's %s layout", (layout, expected) => {
    expect(getSizesAttribute({ layout, width: 800 })).toEqual(expected)
  })
})
