import type { Component, JSX } from "solid-js"
import { renderToString } from "solid-js/web"
import type { LoadedCollections } from "./content.ts"
import { setCollections } from "./runtime.ts"

export interface PageRoute {
  fileName: string
  path: string
}

export interface PageLayoutProps<
  TFrontmatter extends Record<string, unknown> = Record<string, unknown>,
> {
  children: JSX.Element
  frontmatter: TFrontmatter
  route: PageRoute
}

export interface StaticPath {
  params: Record<string, string | undefined>
  props?: Record<string, unknown> | undefined
}

export type GetStaticPaths = () => Promise<StaticPath[]> | StaticPath[]

interface DocumentPage {
  Content: Component
  Layout: Component<PageLayoutProps>
  fileName: string
  frontmatter: Record<string, unknown>
  routePath: string
}

interface StaticPage {
  Content: Component<Record<string, unknown>>
  fileName: string
  path: string
  props: Record<string, unknown>
}

interface DynamicPage {
  Content: Component<Record<string, unknown>>
  getStaticPaths: unknown
  pattern: string
}

interface RenderStaticSiteInput {
  collections: LoadedCollections
  documentPages: DocumentPage[]
  dynamicPages: DynamicPage[]
  staticPages: StaticPage[]
  trailingSlash: "always" | "never"
}

interface StaticSiteRoute {
  fileName: string
  html: string
}

const withDoctype = (html: string): string => `<!doctype html>${html}`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isGetStaticPaths = (value: unknown): value is GetStaticPaths =>
  typeof value === "function"

const pathFromPattern = (
  pattern: string,
  params: Record<string, string | undefined>,
): string =>
  pattern
    .replace(/\[(?<rest>\.\.\.)?(?<name>[^\]]+)\]/g, (...args: unknown[]) => {
      const groups: unknown = args.at(-1)

      if (!isRecord(groups)) {
        throw new TypeError(`Invalid route pattern ${pattern}`)
      }

      const name = groups.name
      const rest = groups.rest

      if (typeof name !== "string") {
        throw new TypeError(`Invalid route parameter in ${pattern}`)
      }

      const value = params[name]

      if (value === undefined && rest !== "...") {
        throw new TypeError(`Missing route parameter ${name} for ${pattern}`)
      }

      return value ?? ""
    })
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "")

const routeFileName = (
  routePath: string,
  trailingSlash: RenderStaticSiteInput["trailingSlash"],
): string => {
  const normalized = routePath.replace(/^\/+|\/+$/g, "")

  if (normalized === "404") {
    return "404.html"
  }

  if (normalized === "") {
    return "index.html"
  }

  return trailingSlash === "always"
    ? `${normalized}/index.html`
    : `${normalized}.html`
}

const requireStaticPaths = (value: unknown, pattern: string): StaticPath[] => {
  if (!Array.isArray(value)) {
    throw new TypeError(`${pattern} getStaticPaths() must return an array`)
  }

  return value.map(item => {
    if (!isRecord(item) || !isRecord(item.params)) {
      throw new TypeError(`${pattern} returned an invalid static path`)
    }

    const params: Record<string, string | undefined> = {}

    for (const [name, parameter] of Object.entries(item.params)) {
      if (parameter !== undefined && typeof parameter !== "string") {
        throw new TypeError(`${pattern} returned an invalid route parameter`)
      }

      params[name] = parameter
    }

    if (item.props !== undefined && !isRecord(item.props)) {
      throw new TypeError(`${pattern} returned invalid static path props`)
    }

    return {
      params,
      ...(item.props === undefined ? {} : { props: item.props }),
    }
  })
}

export const renderStaticSite = async (
  input: RenderStaticSiteInput,
): Promise<StaticSiteRoute[]> => {
  setCollections(input.collections)

  const documentRoutes = input.documentPages.map(page => {
    const Content = page.Content
    const Layout = page.Layout

    return {
      fileName: page.fileName,
      html: withDoctype(
        renderToString(() => (
          <Layout
            frontmatter={page.frontmatter}
            route={{ fileName: page.fileName, path: page.routePath }}
          >
            <Content />
          </Layout>
        )),
      ),
    }
  })
  const staticRoutes = input.staticPages.map(page => ({
    fileName: page.fileName,
    html: withDoctype(
      renderToString(() =>
        page.Content({
          ...page.props,
          route: { fileName: page.fileName, path: page.path },
        }),
      ),
    ),
  }))
  const dynamicRoutes = (
    await Promise.all(
      input.dynamicPages.map(async page => {
        if (!isGetStaticPaths(page.getStaticPaths)) {
          throw new TypeError(`${page.pattern} must export getStaticPaths()`)
        }

        const paths = requireStaticPaths(
          await page.getStaticPaths(),
          page.pattern,
        )

        return paths.map(path => {
          const routePath = pathFromPattern(page.pattern, path.params)
          const fileName = routeFileName(routePath, input.trailingSlash)

          return {
            fileName,
            html: withDoctype(
              renderToString(() =>
                page.Content({
                  ...path.props,
                  route: { fileName, path: routePath },
                }),
              ),
            ),
          }
        })
      }),
    )
  ).flat()
  const routes = [...documentRoutes, ...staticRoutes, ...dynamicRoutes]

  if (new Set(routes.map(route => route.fileName)).size !== routes.length) {
    throw new TypeError("Static-site routes must emit unique file names")
  }

  return routes
}
