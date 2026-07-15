import { describe, expect, test } from "vitest"
import type { Component } from "solid-js"
import type { PageLayoutProps } from "./render.tsx"
import { renderStaticSite } from "./render.tsx"

const RoutePage: Component<Record<string, unknown>> = function (props) {
  const route = props.route

  if (
    typeof route !== "object" ||
    route === null ||
    !("path" in route) ||
    typeof route.path !== "string" ||
    !("fileName" in route) ||
    typeof route.fileName !== "string"
  ) {
    throw new TypeError("Expected page route")
  }

  return <output>{`${route.path}|${route.fileName}`}</output>
}

const RouteLayout: Component<PageLayoutProps> = props => (
  <output>{`${props.route.path}|${props.route.fileName}`}</output>
)

describe("static-site renderer page routes", () => {
  test.each([
    {
      expected: [
        ["reference/index.html", "/reference/|reference/index.html"],
        ["index.html", "/|index.html"],
        ["guides/index.html", "/guides/|guides/index.html"],
        ["404.html", "/404|404.html"],
        ["guides/example/index.html", "/guides/example/|guides/example/index.html"],
      ],
      trailingSlash: "always" as const,
    },
    {
      expected: [
        ["reference.html", "/reference|reference.html"],
        ["index.html", "/|index.html"],
        ["guides.html", "/guides|guides.html"],
        ["404.html", "/404|404.html"],
        ["guides/example.html", "/guides/example|guides/example.html"],
      ],
      trailingSlash: "never" as const,
    },
  ])(
    "exposes public pathnames with trailingSlash $trailingSlash",
    async ({ expected, trailingSlash }) => {
      const routes = await renderStaticSite({
        collections: {},
        documentPages: [
          {
            Content: () => null,
            Layout: RouteLayout,
            fileName:
              trailingSlash === "always"
                ? "reference/index.html"
                : "reference.html",
            frontmatter: {},
            routePath: "reference",
          },
        ],
        dynamicPages: [
          {
            Content: RoutePage,
            getStaticPaths: () => [{ params: { slug: "example" } }],
            pattern: "guides/[slug]",
          },
        ],
        staticPages: [
          {
            Content: RoutePage,
            fileName: "index.html",
            props: {},
            routePath: "",
          },
          {
            Content: RoutePage,
            fileName:
              trailingSlash === "always"
                ? "guides/index.html"
                : "guides.html",
            props: {},
            routePath: "guides",
          },
          {
            Content: RoutePage,
            fileName: "404.html",
            props: {},
            routePath: "404",
          },
        ],
        trailingSlash,
      })

      expect(
        routes.map(route => [
          route.fileName,
          route.html.match(/<output[^>]*>(?<route>[^<]+)<\/output>/)?.groups
            ?.route,
        ]),
      ).toEqual(expected)
    },
  )

  test("normalizes dynamic paths only after expanding parameters", async () => {
    const routes = await renderStaticSite({
      collections: {},
      documentPages: [],
      dynamicPages: [
        {
          Content: RoutePage,
          getStaticPaths: () => [
            { params: { section: "guides", slug: "example?draft=1#top" } },
          ],
          pattern: "[section]/[slug]",
        },
      ],
      staticPages: [],
      trailingSlash: "always",
    })

    expect(routes[0]?.html).toContain(
      ">/guides/example/|guides/example?draft=1#top/index.html</output>",
    )
  })
})
