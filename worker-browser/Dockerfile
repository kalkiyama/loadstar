# Microsoft's Playwright image ships Node 20 + Chromium/Firefox/WebKit preinstalled.
FROM mcr.microsoft.com/playwright:v1.47.0-jammy
WORKDIR /app
COPY package.json ./
COPY api/package.json ./api/
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# The Playwright v1.47.0 image ships Node v20.17.0, which mis-resolves pptxgenjs 4's
# exports map: `import("pptxgenjs")` falls through to the CJS loader, hits the ESM
# build, and throws "Cannot use import statement outside a module". browserWorker.js
# imports buildPptx at module scope, so the container exited 1 on startup EVERY time —
# silently, with no restart policy. Consequences: browser testing unavailable, and the
# `exports` queue never drained, so every PDF request sat at "queued" forever while the
# UI said "a real browser is printing your report".
# api/ and worker/ run node:20-alpine (v20.20.2) and are unaffected — same package,
# same import, different Node minor. Reproduce with:
#   docker run --rm loadstar-v01-worker-browser node --input-type=module \
#     -e "import('pptxgenjs').then(()=>console.log('OK')).catch(e=>console.log(e.message))"
# A lazy import was considered and rejected: browserWorker.js:295 builds the PPTX
# alongside every PDF, so deferring the import moves the crash from startup to first
# use — a worse failure, not a smaller one.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && node --version
RUN cd api && npm install --omit=dev && npm install playwright@1.47.0 --omit=dev \
 && ln -s /app/api/node_modules /app/node_modules
COPY api ./api
COPY worker-browser ./worker-browser
CMD ["node", "worker-browser/browserWorker.js"]
