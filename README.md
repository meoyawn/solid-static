# vite-static-site

An Astro-inspired static site implementation built as a Vite plugin with SolidJS and TSX.

This project is under development and is not published as an npm package yet.

## Setup

Build this project and add it to your app as a local or workspace dependency. Then configure it in `vite.config.ts`:

```ts
import { defineConfig } from "vite";
import { staticSite } from "vite-static-site";
import {
  createHtmlMarkdownProcessor,
  solidMarkdown,
} from "vite-static-site/markdown";

export default defineConfig({
  plugins: [
    staticSite({
      collections: {},
      i18n: {
        defaultLocale: "en",
        locales: ["en"],
        routing: { prefixDefaultLocale: false },
      },
      integrations: [solidMarkdown()],
      markdown: { processor: createHtmlMarkdownProcessor() },
      trailingSlash: "always",
    }),
  ],
});
```

Add `.tsx`, `.md`, or `.mdx` pages under `src/pages`. The directory structure determines each page's route. Markdown pages must declare a SolidJS layout in their frontmatter.

## Documentation

Dedicated documentation is not available yet. For the concepts and intended behavior, see the corresponding Astro guides:

- [Images](https://docs.astro.build/en/guides/images/)
- [Markdown content](https://docs.astro.build/en/guides/markdown-content/)
- [Content collections](https://docs.astro.build/en/guides/content-collections/)
- [Pages](https://docs.astro.build/en/basics/astro-pages/)
- [Configuration](https://docs.astro.build/en/guides/configuring-astro/)
