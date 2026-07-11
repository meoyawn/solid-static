import { describe, expect, test } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import {
  createServer as createHttpServer,
  request as createHttpRequest,
} from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer as createViteServer } from "vite"
import { staticSite } from "./index.ts"

describe("vite static-site development server", () => {
  test("returns an HTTP error when page frontmatter cannot be parsed", async () => {
    const root = await mkdtemp(join(tmpdir(), "vite-static-site-"))

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
              path: "/@vite-static-site/routes.json",
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
