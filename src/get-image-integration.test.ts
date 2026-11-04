import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { load as loadHtml } from "cheerio"
import sharp from "sharp"
import { afterEach, describe, expect, test } from "vitest"
import { build } from "vite"
import { staticSite } from "./index.ts"
import { createHtmlMarkdownProcessor } from "./markdown.ts"

const temporaryRoots: string[] = []

describe("getImage Vite integration", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map(root => rm(root, { force: true, recursive: true })),
    )
  })

  test("shares one SVG pipeline between ResponsiveImage and getImage", async () => {
    const root = await mkdtemp(join(process.cwd(), ".solid-static-images-"))
    const pagesDirectory = join(root, "src", "pages")
    const assetsDirectory = join(root, "src", "assets")

    temporaryRoots.push(root)
    await mkdir(pagesDirectory, { recursive: true })
    await mkdir(assetsDirectory, { recursive: true })
    await writeFile(
      join(assetsDirectory, "source.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="4"><rect width="8" height="4" fill="black"/></svg>',
    )
    await writeFile(
      join(pagesDirectory, "index.tsx"),
      `
import { getImage, ResponsiveImage } from "solid-static/image"
import source from "../assets/source.svg?no-inline"

const first = await getImage({ src: source, format: "jpg", width: 4 })
const second = await getImage({ src: source, format: "jpg", width: 4 })
const shared = await getImage({ src: { src: source, width: 8, height: 4, format: "svg" }, width: 4 })

export default () => (
  <html>
    <head>
      <meta property="og:image" content={first.src} />
      <meta property="twitter:image" content={second.src} />
      <meta name="shared-image" content={shared.src} />
    </head>
    <body>
      <ResponsiveImage id="default" alt="Shared" height={2} src={source} width={4} widths={[2, 4]} />
      <ResponsiveImage id="constrained" alt="Constrained" height={2} src={source} width={4} widths={[2, 4]} layout="constrained" />
      <ResponsiveImage id="fixed" alt="Fixed" height={2} src={source} width={4} widths={[2, 4]} layout="fixed" priority />
      <ResponsiveImage id="full" alt="Full" height={2} src={source} width={4} widths={[2, 4]} layout="full-width" />
      <script type="text/x-template" innerHTML={'<img data-solid-static-image="" data-solid-static-format="webp" data-solid-static-layout="none" src="/template-only.png" width="4">'} />
    </body>
  </html>
)
`,
    )

    await build({
      logLevel: "silent",
      plugins: [
        staticSite({
          collections: {},
          i18n: {
            defaultLocale: "en",
            locales: ["en"],
            routing: { prefixDefaultLocale: false },
          },
          integrations: [],
          markdown: { processor: createHtmlMarkdownProcessor() },
          trailingSlash: "always",
        }),
      ],
      resolve: {
        alias: {
          "solid-static/image": fileURLToPath(
            new URL("./image.tsx", import.meta.url),
          ),
        },
      },
      root,
    })

    const html = await readFile(join(root, "dist", "index.html"), "utf8")
    const $ = loadHtml(html)
    expect($('script[type="text/x-template"]').text()).toEqual(
      '<img data-solid-static-image="" data-solid-static-format="webp" data-solid-static-layout="none" src="/template-only.png" width="4">',
    )
    expect($("#default").attr("data-astro-image")).toEqual(undefined)
    expect($("#default").attr("loading")).toEqual("lazy")
    expect($("#default").attr("decoding")).toEqual("async")
    expect($("#fixed").attr("fetchpriority")).toEqual("high")
    expect($("#fixed").attr("loading")).toEqual("eager")
    expect($("#fixed").attr("decoding")).toEqual("sync")
    for (const [id, layout, sizes] of [
      ["constrained", "constrained", "(min-width: 4px) 4px, 100vw"],
      ["fixed", "fixed", "4px"],
      ["full", "full-width", "100vw"],
    ]) {
      expect($("#" + id).attr("data-astro-image")).toEqual(layout)
      expect($("#" + id).attr("sizes")).toEqual(sizes)
      expect($("#" + id).attr("srcset")).toMatch(/\.webp 2w, .*\.webp 4w$/)
    }
    const imageUrls = [
      ...html.matchAll(
        /<meta property="(?:og|twitter):image" content="(?<url>[^"]+)"/g,
      ),
    ].map(match => match.groups?.url)

    expect(imageUrls).toHaveLength(2)
    expect(imageUrls[0]).toEqual(imageUrls[1])
    expect(imageUrls[0]).toMatch(/^\/assets\/source-[\w-]+\.jpg$/)

    const sharedImageUrl = /<meta name="shared-image" content="(?<url>[^"]+)"/.exec(
      html,
    )?.groups?.url
    const responsiveImageUrl = /<img[^>]+src="(?<url>[^"]+)"/.exec(html)?.groups
      ?.url

    expect(sharedImageUrl).toMatch(/^\/assets\/source-[\w-]+\.webp$/)
    expect(responsiveImageUrl).toEqual(sharedImageUrl)

    const emittedImages = await readdir(join(root, "dist", "assets"))
    const jpegImages = emittedImages.filter(fileName => fileName.endsWith(".jpg"))
    const webpImages = emittedImages.filter(fileName =>
      fileName.endsWith(".webp"),
    )

    expect(jpegImages).toHaveLength(1)
    expect(webpImages).toHaveLength(2)

    const metadata = await sharp(
      join(root, "dist", "assets", jpegImages[0] ?? "missing.jpg"),
    ).metadata()

    expect({
      format: metadata.format,
      height: metadata.height,
      width: metadata.width,
    }).toEqual({
      format: "jpeg",
      height: 2,
      width: 4,
    })
  }, 30_000)

  test("resolves social images before generating metadata and shares identical cards", async () => {
    const root = await mkdtemp(join(process.cwd(), ".solid-static-social-"))
    try {
      await mkdir(join(root, "src", "pages"), { recursive: true })
      await writeFile(join(root, "src", "card.satori.tsx"), `
export default () => <div style={{ display: "flex", fontFamily: "Fixture", fontSize: 12, color: "black", backgroundColor: "white", width: "100%", height: "100%" }}>Card</div>
`)
      await writeFile(join(root, "src", "pages", "index.tsx"), `
import font from "@fontsource/inter/files/inter-latin-400-normal.woff?url&no-inline"
import { getSatoriImage } from "solid-static/satori"
import Card from "../card.satori.tsx"
const options = { element: Card(), fonts: [{ name: "Fixture", src: font, weight: 400 }], width: 64, height: 32 }
const first = await getSatoriImage(options)
const second = await getSatoriImage(options)
export default () => <html><head>
  <meta property="og:image" content={new URL(first.src, "https://example.com").href} />
  <meta name="twitter:image" content={new URL(second.src, "https://example.com").href} />
</head><body><img src={first.src} width={first.width} height={first.height} alt="Fixture" /></body></html>
`)
      await build({
        root, logLevel: "silent",
        plugins: [staticSite({
          collections: {},
          i18n: { defaultLocale: "en", locales: ["en"], routing: { prefixDefaultLocale: false } },
          integrations: [], markdown: { processor: createHtmlMarkdownProcessor() }, trailingSlash: "always",
        })],
      })
      const $ = loadHtml(await readFile(join(root, "dist", "index.html"), "utf8"))
      const src = $("img").attr("src")
      if (src === undefined) throw new Error("Expected a rendered social image")
      expect(src).toMatch(/^\/assets\/social-[\w-]+\.png$/)
      expect($('meta[property="og:image"]').attr("content")).toEqual(`https://example.com${src}`)
      expect($('meta[name="twitter:image"]').attr("content")).toEqual(`https://example.com${src}`)
      const content = await readFile(join(root, "dist", src))
      const metadata = await sharp(content).metadata()
      expect({ format: metadata.format, height: metadata.height, width: metadata.width }).toEqual({ format: "png", height: 32, width: 64 })
      expect(content.length).toBeGreaterThan(64)
      expect(content.length).toBeLessThan(32_768)
      expect((await readdir(join(root, "dist", "assets"))).filter(name => name.endsWith(".png"))).toHaveLength(1)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 10_000)
})
