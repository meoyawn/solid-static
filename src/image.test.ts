import { describe, expect, test } from "vitest"
import { createComponent } from "solid-js"
import { renderToString } from "solid-js/web"
import { ResponsiveImage } from "./image.tsx"

describe("ResponsiveImage", () => {
  test("renders only vite-static-site processing markers", () => {
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

    expect(html).toContain("data-vite-static-site-image")
    expect(html).not.toContain("data-astro-image")
  })
})
