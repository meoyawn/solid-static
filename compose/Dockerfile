FROM ghcr.io/nubjs/nub:0.9.2-slim AS install

USER root
WORKDIR /opt/playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright/browsers

# The client manifest owns the exact server version; nothing comes from host node_modules.
COPY package.json /tmp/solid-static.json
RUN node --input-type=module -e 'import fs from "node:fs"; const source = JSON.parse(fs.readFileSync("/tmp/solid-static.json", "utf8")); fs.writeFileSync("package.json", JSON.stringify({ private: true, dependencies: { "@playwright/test": source.devDependencies["@playwright/test"] } }));' \
    && nub install \
    && nub ci \
    && nub exec playwright install --only-shell chromium

# Keep package-manager binaries and caches out of the browser runtime.
# Debian slim supports Playwright's glibc builds; Alpine does not.
FROM node:26.3.1-trixie-slim
WORKDIR /opt/playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright/browsers
COPY --from=install /opt/playwright /opt/playwright
RUN node node_modules/@playwright/test/cli.js install-deps chromium \
    && rm -rf /var/lib/apt/lists/*

COPY compose/browser-server.ts ./browser-server.ts
ENTRYPOINT ["node", "/opt/playwright/browser-server.ts"]
