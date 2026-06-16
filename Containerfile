# Single tooling image for every `make` target (typecheck / build / test / dev /
# screenshot). Based on a glibc Node image (Playwright does not support Alpine),
# with Chromium's OS libraries baked in once at build time.
#
# The Chromium *binary* is NOT baked in here. It is downloaded per-project by
# `make browsers` into a bind-mounted, git-ignored cache
# (PLAYWRIGHT_BROWSERS_PATH below), so it always matches the project's
# `playwright` npm version and survives `podman run --rm`.
FROM node:22-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright-browsers

# `playwright install-deps` knows the correct apt package list for Chromium; we
# use it only for the system libraries, not the browser download.
RUN apt-get update \
 && npx --yes playwright@1.61.0 install-deps chromium \
 && rm -rf /var/lib/apt/lists/*
