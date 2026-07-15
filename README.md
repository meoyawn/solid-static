# solid-static

An Astro-inspired static site implementation built as a Vite plugin with SolidJS and TSX.

Install from npm:

```sh
nub add solid-static
```

## Setup

Build this project and add it to your app as a local or workspace dependency. Then configure it in `vite.config.ts`:

```ts
import { defineConfig } from "vite";
import { staticSite } from "solid-static";
import {
  createHtmlMarkdownProcessor,
  solidMarkdown,
} from "solid-static/markdown";
import { responsiveImages } from "solid-static/responsive-images";

export default defineConfig({
  plugins: [
    staticSite({
      collections: {},
      i18n: {
        defaultLocale: "en",
        locales: ["en"],
        routing: { prefixDefaultLocale: false },
      },
      integrations: [solidMarkdown(), responsiveImages()],
      markdown: { processor: createHtmlMarkdownProcessor() },
      trailingSlash: "always",
    }),
  ],
});
```

Add `.tsx`, `.md`, or `.mdx` pages under `src/pages`. The directory structure determines each page's route. Markdown pages must declare a SolidJS layout in their frontmatter.

### Page routes

Page components and Markdown or MDX layouts receive a `route` prop. `route.path` is the page's absolute public URL pathname. It never contains a query or hash and never exposes an internal route ID or output file name. Dynamic parameters are expanded before the pathname is normalized.

| Page | `trailingSlash: "always"` | `trailingSlash: "never"` |
| --- | --- | --- |
| Root | `/` | `/` |
| Static TSX `guides.tsx` | `/guides/` | `/guides` |
| Markdown or MDX `guides.md` | `/guides/` | `/guides` |
| Dynamic `guides/[slug].tsx`, slug `example` | `/guides/example/` | `/guides/example` |
| Custom `404.tsx` | `/404` | `/404` |

`route.fileName` remains output-relative: for example, `guides/index.html` in `"always"` mode and `guides.html` in `"never"` mode. A custom 404 is always emitted as `404.html`, while its route identity remains `/404`. When the development server uses that page to answer a missing URL, `route.path` remains `/404`; it does not represent the original request pathname.

### Responsive images

Import an image through Vite, then render it with `ResponsiveImage` in a SolidJS page or component:

```tsx
import hero from "../assets/hero.jpg";
import { ResponsiveImage } from "solid-static/image";

export default function Home() {
  return (
    <ResponsiveImage
      src={hero}
      alt="Mountain landscape"
      width={1600}
      height={900}
      layout="constrained"
      widths={[480, 768, 1200, 1600]}
      sizes="(max-width: 768px) 100vw, 1200px"
      format="webp"
      loading="lazy"
    />
  );
}
```

The responsive images integration generates the requested variants and adds the resulting `srcset` during development and production builds.

## Documentation

Dedicated documentation is not available yet. For the concepts and intended behavior, see the corresponding Astro guides:

- [Images](https://docs.astro.build/en/guides/images/)
- [Markdown content](https://docs.astro.build/en/guides/markdown-content/)
- [Content collections](https://docs.astro.build/en/guides/content-collections/)
- [Pages](https://docs.astro.build/en/basics/astro-pages/)
- [Configuration](https://docs.astro.build/en/guides/configuring-astro/)
