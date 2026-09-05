# Worker image for Render, built from the repository root.
# Based on the Playwright image so Chromium and its system libraries are already present and
# match the installed Playwright version.
FROM mcr.microsoft.com/playwright:v1.56.1-noble

ENV NODE_ENV=production \
    PNPM_HOME=/usr/local/bin \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# Install dependencies first so the layer is cached until a manifest changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/ai/package.json packages/ai/
COPY apps/worker/package.json apps/worker/
# The web app is not built here, but pnpm needs every workspace manifest present to
# resolve a frozen lockfile.
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @christopher/worker... --filter @christopher/db --filter @christopher/core --filter @christopher/ai

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker

EXPOSE 8080
CMD ["pnpm", "--filter", "@christopher/worker", "start"]
