## Design

- When in doubt lookup how https://docs.astro.build/en/getting-started/ does things. We copy Astro design as a vite plugin
- Generate final HTML directly from structured page data, components, and resolved build assets. Never parse, scan, or rewrite rendered HTML, including with regular expressions or placeholder replacement.
- Resolve metadata, stylesheets, scripts, and image URLs before HTML serialization. Generate other output formats from authored source or structured render data, never by parsing generated HTML.

## Tools

- use `aube` as package manager
- use `aube exec` to run binaries

## Verification

- after significant changes run `moon run solid-static:check`

## Releases

- agent can do `moon run solid-static:publish` if human asks for it explicitly. Verbs: "publish"/"release"
