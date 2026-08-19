import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"
import { afterEach, describe, expect, test } from "vitest"
import { build } from "vite"
import { staticSite } from "./index.ts"

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
const shared = await getImage({ src: source, width: 4 })

export default () => (
  <html>
    <head>
      <meta property="og:image" content={first.src} />
      <meta property="twitter:image" content={second.src} />
      <meta name="shared-image" content={shared.src} />
    </head>
    <body>
      <ResponsiveImage alt="Shared" height={2} src={source} width={4} />
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
          markdown: {
            processor: {
              async process() {
                return { toString: () => "" }
              },
            },
          },
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
    expect(webpImages).toHaveLength(1)

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
})
