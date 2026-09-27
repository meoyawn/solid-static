FROM ghcr.io/nubjs/nub:0.9.2

USER root
WORKDIR /opt/playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright/browsers

# The client manifest owns the exact server version; nothing comes from host node_modules.
COPY package.json /tmp/solid-static.json
RUN node --input-type=module -e 'import fs from "node:fs"; const source = JSON.parse(fs.readFileSync("/tmp/solid-static.json", "utf8")); fs.writeFileSync("package.json", JSON.stringify({ private: true, dependencies: { "@playwright/test": source.devDependencies["@playwright/test"] } }));' \
    && nub install \
    && nub exec playwright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/*

COPY compose/browser-server.ts ./browser-server.ts
ENTRYPOINT ["node", "/opt/playwright/browser-server.ts"]
