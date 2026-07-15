import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import {
  createServer as createHttpServer,
  request as createHttpRequest,
} from "node:http"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { build, createServer as createViteServer } from "vite"
import { staticSite } from "./index.ts"
import {
  createHtmlMarkdownProcessor,
  solidMarkdown,
} from "./markdown.ts"

describe("PageRoute Vite rendering", () => {
  test.each(["always", "never"] as const)(
    "keeps development and production route props identical with trailingSlash %s",
    async trailingSlash => {
      expect({
        document: typeof document,
        Element: typeof Element,
      }).toEqual({ document: "undefined", Element: "undefined" })

      const root = await mkdtemp(join(process.cwd(), ".solid-static-routes-"))
      const pagesDirectory = join(root, "src", "pages")
      const routeComponent = `
export default (props: { route: { fileName: string; path: string } }) =>
  <output>{props.route.path}|{props.route.fileName}</output>
`
      const layoutComponent = `
import type { JSX } from "solid-js"

export default (props: {
  children: JSX.Element
  route: { fileName: string; path: string }
}) => (
  <html>
    <body>
      <output>{props.route.path}|{props.route.fileName}</output>
      <main>{props.children}</main>
    </body>
  </html>
)
`

      function plugins() {
        return [
          staticSite({
            collections: {},
            i18n: {
              defaultLocale: "en",
              locales: ["en"],
              routing: { prefixDefaultLocale: false },
            },
            integrations: [solidMarkdown()],
            markdown: { processor: createHtmlMarkdownProcessor() },
            trailingSlash,
          }),
        ]
      }

      function renderedRoute(html: string): string {
        const route = html
          .replaceAll("<!--$-->", "")
          .replaceAll("<!--/-->", "")
          .match(/<output[^>]*>(?<route>[^<]+)/)?.groups?.route

        if (route === undefined) {
          throw new TypeError("Fixture page did not render its route")
        }

        return route
      }

      async function requestPage(
        port: number,
        path: string,
      ): Promise<{ body: string; status: number }> {
        return new Promise((resolve, reject) => {
          const request = createHttpRequest(
            {
              headers: { accept: "text/html" },
              host: "127.0.0.1",
              method: "GET",
              path,
              port,
            },
            response => {
              const chunks: Buffer[] = []

              response.on("data", chunk => chunks.push(Buffer.from(chunk)))
              response.once("end", () =>
                resolve({
                  body: Buffer.concat(chunks).toString(),
                  status: response.statusCode ?? 0,
                }),
              )
            },
          )

          request.once("error", reject)
          request.setTimeout(5_000, () => {
            request.destroy(new Error(`Timed out requesting ${path}`))
          })
          request.end()
        })
      }

      try {
        await mkdir(join(pagesDirectory, "guides"), { recursive: true })
        await mkdir(join(root, "src", "layouts"), { recursive: true })
        await Promise.all([
          writeFile(join(pagesDirectory, "index.tsx"), routeComponent),
          writeFile(join(pagesDirectory, "guides.tsx"), routeComponent),
          writeFile(join(pagesDirectory, "404.tsx"), routeComponent),
          writeFile(
            join(pagesDirectory, "guides", "[slug].tsx"),
            `${routeComponent}\nexport const getStaticPaths = () => [{ params: { slug: "example" } }]\n`,
          ),
          writeFile(
            join(pagesDirectory, "reference.md"),
            "---\nlayout: ../layouts/document.tsx\n---\n\n# SSR-safe Markdown\n\nRendered in **Node production SSR**.\n",
          ),
          writeFile(
            join(root, "src", "layouts", "document.tsx"),
            layoutComponent,
          ),
        ])

        await build({
          logLevel: "silent",
          plugins: plugins(),
          root,
        })

        const expected: [string, string][] =
          trailingSlash === "always"
            ? [
                ["index.html", "/|index.html"],
                ["guides/index.html", "/guides/|guides/index.html"],
                ["reference/index.html", "/reference/|reference/index.html"],
                [
                  "guides/example/index.html",
                  "/guides/example/|guides/example/index.html",
                ],
                ["404.html", "/404|404.html"],
              ]
            : [
                ["index.html", "/|index.html"],
                ["guides.html", "/guides|guides.html"],
                ["reference.html", "/reference|reference.html"],
                [
                  "guides/example.html",
                  "/guides/example|guides/example.html",
                ],
                ["404.html", "/404|404.html"],
              ]
        const productionRoutes = await Promise.all(
          expected.map(async ([fileName]) => [
            fileName,
            renderedRoute(await readFile(join(root, "dist", fileName), "utf8")),
          ]),
        )
        const referenceFileName =
          trailingSlash === "always"
            ? "reference/index.html"
            : "reference.html"
        const referenceHtml = await readFile(
          join(root, "dist", referenceFileName),
          "utf8",
        )

        expect(productionRoutes).toEqual(expected)
        expect(referenceHtml).toMatch(
          /<h1[^>]*>SSR-safe Markdown<\/h1>/,
        )
        expect(referenceHtml).toMatch(
          /<p[^>]*>Rendered in <strong[^>]*>Node production SSR<\/strong>\.<\/p>/,
        )

        const viteServer = await createViteServer({
          appType: "spa",
          logLevel: "silent",
          plugins: plugins(),
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

          const requestPaths =
            trailingSlash === "always"
              ? ["/", "/guides/", "/reference/", "/guides/example/"]
              : ["/", "/guides", "/reference", "/guides/example"]
          const developmentRoutes = await Promise.all(
            requestPaths.map(async path => {
              const response = await requestPage(address.port, path)
              return renderedRoute(response.body)
            }),
          )
          const missing = await requestPage(address.port, "/missing")

          expect(developmentRoutes).toEqual(
            expected.slice(0, 4).map(([, route]) => route),
          )
          expect({
            route: renderedRoute(missing.body),
            status: missing.status,
          }).toEqual({ route: "/404|404.html", status: 404 })
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
    },
    30_000,
  )
})
