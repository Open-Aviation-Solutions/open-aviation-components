.PHONY: help dev build build-lib typecheck preview install

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "%-12s %s\n", $$1, $$2}'

node_modules: package-lock.json
	npm install
	@touch node_modules

install: node_modules ## Install dependencies

dev: node_modules ## Start dev server at localhost:4321
	npm run dev

build: node_modules ## Build docs site to ./dist/
	npm run build

build-lib: node_modules ## Build component library to ./dist/lib/
	npm run build:lib

typecheck: node_modules ## Run TypeScript type checking
	npm run typecheck

preview: build ## Preview the built docs site locally
	npm run preview
