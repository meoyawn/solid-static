import { describe, expect, test } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import {
  createServer as createHttpServer,
  request as createHttpRequest,
} from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer as createViteServer } from "vite"
import { createSitemap, staticSite } from "./index.ts"
import {
  createMarkdownSiblings,
  markdownFileNameFor,
} from "./markdown-export.ts"

describe("Markdown export", () => {
  test("maps an empty HTML basename to the root Markdown document", () => {
    expect(markdownFileNameFor(".html")).toBe("index.md")
  })

  test("generates route siblings from main content and applies exclusions", async () => {
    await expect(
      createMarkdownSiblings(
        [
          {
            fileName: "index.html",
            html: `<html><body><header>Navigation</header><main><h1>Hello</h1><p>Read <a href="/about/">about</a>.</p><pre><code class="language-ts">const value = 1</code></pre></main><footer>Footer</footer></body></html>`,
          },
          {
            fileName: "404.html",
            html: "<html><body><main>Not found</main></body></html>",
          },
        ],
        {
          exclude: ["404.html"],
          transform: (markdown, fileName) => `<!-- ${fileName} -->\n\n${markdown}`,
        },
      ),
      ).resolves.toEqual([
        {
          fileName: "index.md",
          source:
            '<!-- index.html -->\n\n# Hello\n\nRead [about](/about/).\n\n```ts\nconst value = 1\n```\n',
        },
      ])

    await expect(
      createMarkdownSiblings(
        [
          {
            fileName: "writing/example/index.html",
            html: "<main><h1>Example</h1></main>",
          },
        ],
        {},
      ),
    ).resolves.toEqual([
      {
        fileName: "writing/example/index.md",
        source: "# Example\n",
      },
    ])
  })
})

describe("sitemap generation", () => {
  test("emits canonical URLs for generated pages and skips the 404 page", () => {
    expect(
      createSitemap(
        [
          { fileName: "index.html" },
          { fileName: "about/index.html" },
          { fileName: "writing/example/index.html" },
          { fileName: "404.html" },
        ],
        { lastmod: "2026-08-22", site: "https://example.com/" },
        "always",
      ),
    ).toEqual(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        '  <url><loc>https://example.com/</loc><lastmod>2026-08-22</lastmod></url>',
        '  <url><loc>https://example.com/about/</loc><lastmod>2026-08-22</lastmod></url>',
        '  <url><loc>https://example.com/writing/example/</loc><lastmod>2026-08-22</lastmod></url>',
        "</urlset>",
        "",
      ].join("\n"),
    )
  })
})

describe("vite static-site development server", () => {
  test("returns an HTTP error when page frontmatter cannot be parsed", async () => {
    const root = await mkdtemp(join(tmpdir(), "solid-static-"))

    try {
      await mkdir(join(root, "src", "pages"), { recursive: true })
      await writeFile(
        join(root, "src", "pages", "index.md"),
        "---\nlayout: [invalid\n---\n",
      )

      const viteServer = await createViteServer({
        appType: "spa",
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
        root,
        server: { middlewareMode: false },
      })
      const httpServer = createHttpServer(viteServer.middlewares)

      try {
        await new Promise<void>((resolve, reject) => {
          httpServer.once("error", reject)
          httpServer.listen(0, "127.0.0.1", () => {
            httpServer.off("error", reject)
            resolve()
          })
        })
        const address = httpServer.address()

        if (address === null || typeof address === "string") {
          throw new Error("Expected test server TCP address")
        }

        const port = address.port
        const status = await new Promise<number>((resolve, reject) => {
          const request = createHttpRequest(
            {
              host: "127.0.0.1",
              method: "GET",
              path: "/@solid-static/routes.json",
              port,
            },
            response => {
              response.resume()
              response.once("end", () => resolve(response.statusCode ?? 0))
            },
          )

          request.once("error", reject)
          request.setTimeout(2_000, () => {
            request.destroy(new Error("Timed out requesting invalid frontmatter"))
          })
          request.end()
        })

        expect(status).toEqual(500)
      } finally {
        if (httpServer.listening) {
          await new Promise<void>((resolve, reject) => {
            httpServer.close(error => {
              if (error === undefined) {
                resolve()
              } else {
                reject(error)
              }
            })
          })
        }
        await viteServer.close()
      }
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 10_000)
})
