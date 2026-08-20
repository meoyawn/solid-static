# solid-static

An Astro-inspired static site implementation built as a Vite plugin with SolidJS and TSX.

Read the introduction: [Another static site generator](https://adelnz.com/writing/another-static-site-generator/).

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

### Client islands

Import a self-mounting browser entry with the `?island` query, then reference the returned URL from a module script. The page remains static HTML; only the named entry and its imports are compiled for the browser.

```tsx
import counterIsland from "../app/counter-island.tsx?island";

export default () => (
  <html>
    <body>
      <div id="counter">0</div>
      <script type="module" src={counterIsland} />
    </body>
  </html>
);
```

```tsx
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

const Counter = () => {
  const [count, setCount] = createSignal(0);

  return <button onClick={() => setCount(value => value + 1)}>{count()}</button>;
};

const root = document.querySelector("#counter");

if (!(root instanceof HTMLElement)) {
  throw new TypeError("Missing #counter island root");
}

render(() => <Counter />, root);
```

Vite serves the source entry during development. Production builds emit hashed JavaScript and CSS assets and rewrite only pages that reference the island.

Use `client` to configure the clean nested browser build explicitly. It accepts
Vite configuration such as aliases, defines, mode, CSS options, browser-only
plugins, and build target or minification settings. Server integrations are not
forwarded automatically.

```ts
staticSite({
  client: {
    build: { minify: false, target: "es2020" },
    define: { __BROWSER__: "true" },
    resolve: { alias: { "@client": "/src/client" } },
  },
  // Other static-site options.
});
```

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

### `getImage()`

Use `getImage()` during server rendering to generate one transformed image. It follows Astro's [`getImage()` pattern](https://docs.astro.build/en/guides/images/#generating-images-with-getimage) for images used outside a standard image component. Import it from `solid-static/image`, then await it at module scope or inside an async server-rendered component:

```tsx
import source from "../assets/social-preview.png";
import { getImage } from "solid-static/image";

const preview = await getImage({
  src: source,
  width: 1200,
  height: 630,
  format: "jpg",
  quality: "high",
  fit: "cover",
  position: "center",
});

export default function Page() {
  return (
    <html>
      <head>
        <meta property="og:image" content={preview.src} />
      </head>
      <body>
        <img src={preview.src} alt="" {...preview.attributes} />
      </body>
    </html>
  );
}
```

`getImage(options)` accepts:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `src` | `string \| ImageMetadata` | required | Imported image URL or `{ src, width, height, format }` metadata. |
| `width` | positive integer | source width | Output width. |
| `height` | positive integer | source height | Output height. |
| `format` | `"avif" \| "jpeg" \| "jpg" \| "png" \| "webp"` | `"webp"` | Output format. |
| `quality` | `0`–`100` or `"low" \| "mid" \| "high" \| "max"` | encoder default | Output quality. |
| `fit` | `"contain" \| "cover" \| "fill" \| "inside" \| "outside"` | `"cover"` | How the source fits the requested dimensions. |
| `position` | `string` | `"center"` | Crop or embed position used by the image transformer. |

When `src` contains image metadata, specifying only `width` or `height` infers the other dimension while preserving the aspect ratio. The returned promise resolves to a `GetImageResult` containing the generated `src`, inferred `attributes`, normalized `options`, original `rawOptions`, and an Astro-compatible `srcSet` object. Generated URLs work in both the Vite development server and production builds. `getImage()` throws if called in the browser.

## Documentation

Dedicated documentation is not available yet. For the concepts and intended behavior, see the corresponding Astro guides:

- [Images](https://docs.astro.build/en/guides/images/)
- [Markdown content](https://docs.astro.build/en/guides/markdown-content/)
- [Content collections](https://docs.astro.build/en/guides/content-collections/)
- [Internationalization](https://docs.astro.build/en/guides/internationalization/)
- [Pages](https://docs.astro.build/en/basics/astro-pages/)
- [Configuration](https://docs.astro.build/en/guides/configuring-astro/)
