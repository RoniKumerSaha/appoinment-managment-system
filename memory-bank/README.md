# Memory Bank

Project context for AI agents working on this repository.

**Everything here was derived by reading the source, not by asking
someone to describe it.** Every claim is traceable to a file in the
repository, and where a convention is *emergent* rather than *enforced*,
the file says so — that distinction is the most useful thing in the
whole set.

## Where to start

| If you are… | Read |
|---|---|
| Writing API code | `standards/api-conventions.md` → `standards/data-stack.md` → `standards/coding-standards.md` |
| Writing UI code | `standards/ux-guide.md` → `standards/coding-standards.md` |
| Adding a route family | `standards/system-architecture.md` (the `wrapRouter` warning) → `standards/api-conventions.md` (the Vite proxy map) |
| Choosing a library or tool | `standards/tech-stack.md` (every "no" is load-bearing) |
| Reviewing a diff | `standards/coding-standards.md` § "Enforced invariants" |
| Looking for a story | `story-index.md` |

## Contents

| File | What it covers |
|---|---|
| `project.yaml` | Project type, init metadata, and the divergence note against the planning docs. |
| `story-index.md` | The 79-story catalogue, mapped to the BMAD spec files. |
| `standards/tech-stack.md` | TypeScript, Express, React, pnpm, JWT, testing, and every deliberate omission. |
| `standards/data-stack.md` | PostgreSQL, raw `pg`, the GIST exclusion constraint, transactions, migrations, seeds. |
| `standards/coding-standards.md` | Formatting (emergent), lint, naming, file layout, testing, error handling, logging, and the **enforced invariants**. |
| `standards/system-architecture.md` | Layered monolith, middleware order, authorization, domain model, the 8 architectural invariants, and the divergences table. |
| `standards/ux-guide.md` | Design tokens, the token-only rule, the `ConflictModal` contract, global a11y, routing, the login split. |
| `standards/api-conventions.md` | Route families, validation, response shapes, the error envelope, status codes, SQLSTATE mapping, transactions, audit. |
| `standards/decision-index.md` | The ADR index (empty — no ADR bolts yet) plus the nine pre-existing architectural decisions. |
| `operations/runtime-and-observability.md` | Ports, env vars, seeds, health, metrics, CI, and the deployment deferrals. |

## The three things to know before you write code

**1. The API is the single source of truth for availability.** The UI
shows slots; only the server may grant or release one. There are no
tentative client-side holds.

**2. A new router must join the `wrapRouter` loop** at
`apps/api/src/app.ts:82-119`. Express 4 does not await async handlers,
so a rejection outside that loop is an unhandled rejection, which Node
escalates to `process.exit(1)` — the whole API dies with no error
response.

**3. The implementation is the contract.**
`_bmad-output/planning-artifacts/architecture.md` was written before the
code landed and describes a different stack. When it and the code
disagree, follow the code and correct the document. See
`standards/system-architecture.md` § "Divergences from the planning
document".

## Conventions

- Timestamps are `YYYY-MM-DDTHH:MM:SSZ` (ISO 8601 with time).
- Intents are `{NNN}-{name}`, units `{UUU}-{name}`, stories
  `{SSS}-{title-slug}.md`, bolts `{BBB}-{unit-name}/`.
- Standards files are named after the standard id in
  `.specsmd/aidlc/templates/standards/catalog.yaml`.
