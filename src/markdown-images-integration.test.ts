import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import sharp from "sharp"
import { describe, expect, test } from "vitest"
import { build, createServer } from "vite"
import type { ViteDevServer } from "vite"
import { staticSite } from "./index.ts"
import { createHtmlMarkdownProcessor, solidMarkdown } from "./markdown.ts"

describe("Markdown image pipeline", () => {
  test.each(["production", "development"])(
    "optimizes relative and reference images by default in %s",
    async mode => {
      const root = await mkdtemp(join(process.cwd(), ".solid-static-images-"))
      const directory = join(root, "src/content/writing/nested")
      let server: ViteDevServer | undefined

      try {
        await mkdir(directory, { recursive: true })
        await mkdir(join(root, "src/pages/writing"), { recursive: true })
        await mkdir(join(root, "src/layouts"), { recursive: true })
        await sharp({
          create: { background: "red", channels: 3, height: 400, width: 800 },
        }).png().toFile(join(directory, "screen shot.png"))
        await Promise.all([
          writeFile(join(directory, "index.md"), `---
title: Nested article
---
![Local & screenshot](./screen%20shot.png "A quoted 'title'")

![Reference][screenshot]

[screenshot]: ./screen%20shot.png

![Remote](https://example.com/remote.png)

![Public](/public-image.png)
`),
          writeFile(join(root, "src/pages/index.md"), `---
layout: ../layouts/document.tsx
---
# Markdown page

![Page image](../content/writing/nested/screen%20shot.png)

Plain Markdown keeps {braces} as text.
`),
          writeFile(join(root, "src/pages/example.mdx"), `---
layout: ../layouts/document.tsx
---
export const answer = 42

![MDX image](../content/writing/nested/screen%20shot.png)

Answer: {answer}
`),
          writeFile(join(root, "src/layouts/document.tsx"), `
export default props => <html><body>{props.children}</body></html>
`),
          writeFile(join(root, "src/pages/writing/[...slug].tsx"), `
import { getCollection } from "solid-static/runtime"
export const getStaticPaths = () => getCollection("writing").map(entry => ({
  params: { slug: entry.id }, props: { entry },
}))
export default props => <html><body><article innerHTML={props.entry.rendered.html} /></body></html>
`),
        ])

        const config = {
          logLevel: "silent" as const,
          plugins: [staticSite({
            collections: {
              writing: { directory: join(root, "src/content/writing"), pattern: /\.md$/ },
            },
            i18n: {
              defaultLocale: "en",
              locales: ["en"],
              routing: { prefixDefaultLocale: false },
            },
            integrations: [solidMarkdown()],
            markdown: { processor: createHtmlMarkdownProcessor() },
            markdownExport: { exclude: [] },
            trailingSlash: "always",
          })],
          root,
        }

        if (mode === "production") {
          await build(config)
        } else {
          server = await createServer({ ...config, server: { port: 0 } })
          await server.listen()
        }

        const origin = server?.resolvedUrls?.local[0]
        async function readOutput(path: string): Promise<Buffer> {
          if (origin === undefined) {
            return readFile(join(root, "dist", decodeURIComponent(path)))
          }
          const response = await fetch(new URL(path, origin))
          expect(response.ok, `Expected ${path} to return successfully, received ${response.status}`).toEqual(true)
          return Buffer.from(await response.arrayBuffer())
        }

        const article = (await readOutput("writing/nested/index.html")).toString()
        const page = (await readOutput("index.html")).toString()
        const mdx = (await readOutput("example/index.html")).toString()
        const images = [...article.matchAll(/<img[^>]+>/g)].map(match => match[0])
        expect(images).toHaveLength(4)
        const imagePath = /src="(?<path>[^"]+)"/.exec(images[0] ?? "")?.groups?.path
        expect(imagePath).toMatch(/\/(assets|@solid-static\/images)\/[^/]+\.webp$/)
        expect(images[0]).toMatch(/alt="Local &(?:amp|#38|#x26); screenshot"/)
        expect(images[0]).toMatch(/title="A quoted (?:'|&#(?:39|x27);)title(?:'|&#(?:39|x27);)"/)
        expect(images[2]).toContain('src="https://example.com/remote.png"')
        expect(images[3]).toContain('src="/public-image.png"')

        expect(images[0]).toContain('width="800"')
        expect(images[0]).toContain('height="400"')
        expect(images[0]).toMatch(/srcset="[^"]+ \d+w, [^"]+ \d+w"/)
        expect(images[1]).toContain(`src="${imagePath}"`)
        expect(page).toContain(`src="${imagePath}"`)
        expect(page).toContain("Plain Markdown keeps {braces} as text.")
        expect(mdx).toContain(`src="${imagePath}"`)
        expect(mdx).toMatch(/Answer: [\s\S]*42/)

        const optimized = await sharp(await readOutput(imagePath ?? "missing.webp")).metadata()
        expect({ format: optimized.format, height: optimized.height, width: optimized.width })
          .toEqual({ format: "webp", height: 400, width: 800 })

        if (mode === "production") {
          const markdown = (await readOutput("writing/nested/index.md")).toString()
          const original = /!\[[^\]]*\]\((?<path>\/assets\/[^\s)]+)/.exec(markdown)?.groups?.path
          expect(original).toMatch(/^\/assets\/[^/]+\.png$/)
          expect((await readOutput(original ?? "missing.png")).length).toBeGreaterThan(0)
          expect(markdown).not.toContain("./screen%20shot.png")
        } else {
          await writeFile(join(directory, "screen shot.png"), await sharp({
            create: { background: "blue", channels: 3, height: 400, width: 800 },
          }).png().toBuffer())
          await expect.poll(async () => {
            const refreshed = (await readOutput("writing/nested/index.html")).toString()
            return /<img[^>]+src="(?<path>[^"]+)"/.exec(refreshed)?.groups?.path
          }).not.toEqual(imagePath)
        }
      } finally {
        await server?.close()
        await rm(root, { force: true, recursive: true })
      }
    },
    30_000,
  )
})
