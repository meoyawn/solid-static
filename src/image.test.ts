import { describe, expect, test } from "vitest"
import { createComponent } from "solid-js"
import { renderToString } from "solid-js/web"
import { ResponsiveImage } from "./image.tsx"

describe("ResponsiveImage", () => {
  test.each(["constrained", "fixed", "full-width"] as const)(
    "renders Astro-compatible %s layout metadata",
    layout => {
      const html = renderToString(() =>
        createComponent(ResponsiveImage, {
          alt: "Example",
          height: 360,
          layout,
          sizes: "100vw",
          src: "/example.png",
          width: 640,
          widths: [320, 640],
        }),
      )

      expect(html).toContain(`data-astro-image="${layout}"`)
      expect(html).toContain("data-solid-static-image")
    },
  )

  test.each([
    ["constrained", "(min-width: 640px) 640px, 100vw"],
    ["fixed", "640px"],
    ["full-width", "100vw"],
  ] as const)("derives Astro's %s sizes", (layout, sizes) => {
    const html = renderToString(() =>
      createComponent(ResponsiveImage, {
        alt: "Example",
        height: 360,
        layout,
        src: "/example.png",
        width: 640,
      }),
    )

    expect(html).toContain(`sizes="${sizes}"`)
  })

  test("defaults to Astro's none layout", () => {
    const html = renderToString(() =>
      createComponent(ResponsiveImage, {
        alt: "Example",
        height: 360,
        sizes: "100vw",
        src: "/example.png",
        width: 640,
        widths: [320, 640],
      }),
    )

    expect(html).toContain("data-solid-static-image")
    expect(html).not.toContain("data-astro-image")
  })

  test("uses Astro's lazy-loading defaults", () => {
    const html = renderToString(() =>
      createComponent(ResponsiveImage, {
        alt: "Example",
        height: 360,
        src: "/example.png",
        width: 640,
      }),
    )

    expect(html).toContain('decoding="async"')
    expect(html).toContain('loading="lazy"')
    expect(html).not.toContain("fetchpriority")
  })

  test("uses Astro's priority defaults", () => {
    const html = renderToString(() =>
      createComponent(ResponsiveImage, {
        alt: "Example",
        height: 360,
        priority: true,
        src: "/example.png",
        width: 640,
      }),
    )

    expect(html).toContain('decoding="sync"')
    expect(html).toContain('fetchpriority="high"')
    expect(html).toContain('loading="eager"')
  })

  test("renders an explicit none layout without Astro layout metadata", () => {
    const html = renderToString(() =>
      createComponent(ResponsiveImage, {
        alt: "Example",
        height: 360,
        layout: "none",
        sizes: "100vw",
        src: "/example.png",
        width: 640,
        widths: [320, 640],
      }),
    )

    expect(html).not.toContain("data-astro-image")
  })
})
