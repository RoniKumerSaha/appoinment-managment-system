# Clinic scheduling — developer aliases.
# Real work happens via pnpm scripts; this file is a shortcut layer.

.PHONY: dev build lint typecheck test install db-migrate db-seed clean

dev:
	pnpm -w dev

build:
	pnpm -w build

lint:
	pnpm -w lint

typecheck:
	pnpm -w typecheck

test:
	pnpm -w test

install:
	pnpm install

db-migrate:
	pnpm -w db:migrate

db-seed:
	pnpm -w db:seed

clean:
	rm -rf node_modules apps/*/node_modules packages/*/node_modules
