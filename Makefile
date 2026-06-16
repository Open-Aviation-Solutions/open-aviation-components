.PHONY: help dev build build-lib typecheck preview install test check screenshot browsers tooling-image

# --- Node toolchain -----------------------------------------------------------
# Prefer a locally installed npm. If none is present, run all Node tooling
# inside a single local container image (see Containerfile) built on top of
# podman or docker. The project tree is bind-mounted, so node_modules, build
# output, and screenshots land in the working tree just as a local run would.
TOOLING_IMAGE ?= open-aviation-components-tooling:latest
LOCAL_NPM := $(shell command -v npm 2>/dev/null)
CONTAINER_RUNTIME := $(shell command -v podman 2>/dev/null || command -v docker 2>/dev/null)

ifndef LOCAL_NPM
  ifndef CONTAINER_RUNTIME
    $(error No local npm and no container runtime (podman/docker) found — install one)
  endif
  RUN_BASE := $(CONTAINER_RUNTIME) run --rm -v "$(CURDIR)":/app:Z -w /app
  # One-shot tooling: skip Playwright's browser download on plain installs (the
  # browser is fetched explicitly by `make browsers`).
  NPM := $(RUN_BASE) -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 $(TOOLING_IMAGE) npm
  NODE := $(RUN_BASE) $(TOOLING_IMAGE) node
  # Dev server: keep it attached, publish the port, bind to all interfaces.
  DEV := $(CONTAINER_RUNTIME) run --rm -it -v "$(CURDIR)":/app:Z -w /app -p 4321:4321 $(TOOLING_IMAGE) npm run dev -- --host 0.0.0.0
  IMAGE_DEP := tooling-image
else
  NPM := npm
  NODE := node
  DEV := npm run dev
  IMAGE_DEP :=
endif
# ------------------------------------------------------------------------------

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "%-14s %s\n", $$1, $$2}'

tooling-image:
ifdef CONTAINER_RUNTIME
	@$(CONTAINER_RUNTIME) image inspect $(TOOLING_IMAGE) >/dev/null 2>&1 \
		|| $(CONTAINER_RUNTIME) build -t $(TOOLING_IMAGE) -f Containerfile .
endif

node_modules: package.json package-lock.json | $(IMAGE_DEP)
	$(NPM) install
	@touch node_modules

install: node_modules ## Install dependencies

dev: node_modules ## Start dev server at localhost:4321
	$(DEV)

build: node_modules ## Build docs site to ./dist/ and component library to ./dist/lib/
	$(NPM) run build
	$(NPM) run build:lib

build-lib: node_modules ## Build component library to ./dist/lib/
	$(NPM) run build:lib

test: node_modules ## Run tests
	$(NPM) test

check: typecheck build test ## Run all checks (typecheck, build, test)

typecheck: node_modules ## Run TypeScript type checking
	$(NPM) run typecheck

browsers: node_modules ## Download the Chromium build Playwright needs
	$(NPM) exec -- playwright install chromium

screenshot: build browsers ## Capture screenshots of the built site to ./screenshots/
	$(NODE) scripts/screenshot.mjs

preview: build ## Preview the built docs site locally
	$(NPM) run preview
