.PHONY: help dev build build-lib typecheck preview install test check

# --- Node toolchain -----------------------------------------------------------
# Prefer a locally installed npm. If none is present, fall back to running the
# Node tooling inside a container (podman or docker) — the project source is
# bind-mounted, so node_modules and build output land in the working tree just
# as a local install would. Override the image with NODE_IMAGE=... if needed.
NODE_IMAGE ?= node:22-alpine
LOCAL_NPM := $(shell command -v npm 2>/dev/null)
CONTAINER_RUNTIME := $(shell command -v podman 2>/dev/null || command -v docker 2>/dev/null)

ifndef LOCAL_NPM
  ifndef CONTAINER_RUNTIME
    $(error No local npm and no container runtime (podman/docker) found — install one)
  endif
  # One-shot tooling (install, typecheck, build, test): run and exit.
  NPM := $(CONTAINER_RUNTIME) run --rm -v "$(CURDIR)":/app:Z -w /app $(NODE_IMAGE) npm
  # Dev server: keep it attached, publish the port, and bind to all interfaces
  # so it is reachable from the host.
  DEV := $(CONTAINER_RUNTIME) run --rm -it -p 4321:4321 -v "$(CURDIR)":/app:Z -w /app $(NODE_IMAGE) npm run dev -- --host 0.0.0.0
else
  NPM := npm
  DEV := npm run dev
endif
# ------------------------------------------------------------------------------

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "%-12s %s\n", $$1, $$2}'

node_modules: package.json package-lock.json
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

preview: build ## Preview the built docs site locally
	$(NPM) run preview
