# Worker image for Render, built from the repository root.
# Based on the Playwright image so Chromium and its system libraries are already present and
# match the installed Playwright version.
FROM mcr.microsoft.com/playwright:v1.56.1-noble

ENV NODE_ENV=production \
    PNPM_HOME=/usr/local/bin \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# An init process as PID 1. It forwards the platform's SIGTERM to Node, so the shutdown handler
# still runs, and it reaps the renderer, GPU and zygote processes a crashed Chromium leaves
# behind: they are reparented to PID 1, and Node never waits for children it did not spawn.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

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
# Handed to the image's unprivileged pwuser in the same layer, so node_modules is not copied twice.
RUN pnpm install --frozen-lockfile --filter @ava/worker... --filter @ava/db --filter @ava/core --filter @ava/ai \
 && chown -R pwuser:pwuser /app

COPY --chown=pwuser:pwuser tsconfig.base.json ./
COPY --chown=pwuser:pwuser packages ./packages
COPY --chown=pwuser:pwuser apps/worker ./apps/worker

# Not root: Chromium renders untrusted careers pages with its sandbox off (a container rarely
# allows the user namespaces it needs), and this process holds the database URL and the API key.
USER pwuser
EXPOSE 8080
WORKDIR /app/apps/worker
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "src/index.ts"]
