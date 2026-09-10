# Trigger Map — Appointment Management System

> **What is this?** A "when X happens, do Y" cheat sheet for your BMad workflow.
> Scan the **Trigger** column to find your current situation, then run the matching skill from the **Action** column.

---

## 🚨 How to Use This Map

1. **Identify your situation** — what's happening right now in your project?
2. **Match a trigger row** — find the closest match in the table below.
3. **Run the action** — invoke the skill (preferably in a fresh context window).
4. **Skip optional ones** — if no row matches, just continue or run `/bmad-help` (BH).

---

## 🟢 Phase 1 — Ideation (Before You Have a PRD)

| Trigger (situation) | Action | Menu Code |
|---|---|---|
| I have a vague idea and want to pressure-test it before committing | `/bmad-forge-idea` | **FI** |
| I need to research a market / domain / tech question | `/bmad-deep-recon` | **RS** |
| I want to brainstorm with structured techniques | `/bmad-brainstorming` | **BP / BSP** |
| I want a Working Backwards press-release-style concept test | `/bmad-prfaq` | **WB** |
| I'm already sure of my concept, just want a brief | `/bmad-product-brief` | **CB** |

---

## 🟡 Phase 2 — Planning (PRD → Architecture → Epics)

> **Required sequence:** PRD → (UX optional) → Architecture → Epics & Stories → Sprint Status

| Trigger (situation) | Action | Menu Code |
|---|---|---|
| I need to create or update the PRD | `/bmad-prd` | **PRD** |
| UI is core to the project and I haven't planned UX yet | `/bmad-ux` | **CU** |
| I want to summarize or refresh where planning stands | `/bmad-sprint-planning` (status action) | **SS** |
| Requirements are stable and I need an architecture spine | `/bmad-architecture` | **CA** |
| Architecture is approved, break it into buildable stories | `/bmad-create-epics-and-stories` | **CE** |
| Planning is complete and I want a sprint-status file to track work | `/bmad-sprint-planning` | **SP** |

---

## 🔵 Phase 3 — Ship / Implementation

> **Required loop:** Build → Code Review → (Retrospective at epic end) → Build next

| Trigger (situation) | Action | Menu Code |
|---|---|---|
| I'm ready to implement the next story | `/bmad-build` | **BD** |
| A story's implementation is done — I want a deeper review pass | `/bmad-code-review` | **CR** |
| An entire epic is done — capture lessons and improvements | `/bmad-retrospective` | **ER** |
| I want to generate API + E2E tests for implemented code | `/bmad-qa-generate-e2e-tests` | **QA** |
| I want a guided walkthrough of a commit/branch/PR for human review | `/bmad-checkpoint-preview` | **CK** |

---

## 🟠 Phase 4 — Change Management (Mid-Sprint)

| Trigger (situation) | Action | Menu Code |
|---|---|---|
| Scope, requirements, or compliance changed significantly | `/bmad-correct-course` | **CC** |
| I need to revise the PRD against a change signal | `/bmad-prd` (update action) | **PRD** |
| I want to re-derive architecture from a new constraint | `/bmad-architecture` (update action) | **CA** |
| Epics need to be re-cut after a change | `/bmad-create-epics-and-stories` (update action) | **CE** |

---

## 🟣 Anytime — Quality, Critique, Orientation

| Trigger (situation) | Action | Menu Code |
|---|---|---|
| I'm stuck or unsure what to do next | `/bmad-help` | **BH** |
| I want a draft (PRD, doc, story, diff) tightened / improved | `/bmad-review` | **RV** |
| I want deeper critique on a just-produced plan (pre-mortem, red team, etc.) | `/bmad-advanced-elicitation` | **AE** |
| I want multiple agent perspectives debating one decision | `/bmad-party-mode` | **PM** |
| I want AI agents to behave correctly in this repo (AGENTS.md setup) | `/bmad-project-context` | **PC** |
| I want to change how an agent or workflow behaves | `/bmad-customize` | **BC** |
| I want to condense messy inputs into a SPEC.md contract | `/bmad-spec` | **SPC** |

---

## 🎯 Your Project — Current State

**Project:** Appointment Management System (Multi-Branch Clinic Scheduling)
**Phase:** Between Phase 3 (Planning) and Phase 4 (Implementation)
**Sprint status:** All 7 epics in `backlog`, all stories in `backlog`, no implementation yet.

### What's done ✅
- BRD, PRD, UX-FLOWS, Architecture, Epics & Stories, Design System
- Sprint status file generated (09-06-2026)

### What's NOT done ❌
- No story files exist yet
- No source code in `apps/api/src` or `apps/web/src` (only `dist` + `node_modules`)

### Recommended next row → run this
| Trigger matched | Action |
|---|---|
| "Planning complete, ready to build the first story" | `/bmad-build` for E3-S1 (Availability Engine) |

---

## 📋 Quick Reference — All Skills by Code

| Code | Skill | When |
|---|---|---|
| **BH** | bmad-help | Stuck, want orientation |
| **BP** | bmad-brainstorming (BMM) | Need structured ideation |
| **BSP** | bmad-brainstorming (Core) | Need structured ideation |
| **CB** | bmad-product-brief | Want a quick brief |
| **CC** | bmad-correct-course | Major scope change |
| **CE** | bmad-create-epics-and-stories | Break architecture into stories |
| **CK** | bmad-checkpoint-preview | Human review of a change |
| **CR** | bmad-code-review | Deeper review of a diff |
| **CU** | bmad-ux | Plan UX design |
| **CA** | bmad-architecture | Create architecture spine |
| **ER** | bmad-retrospective | End-of-epic lessons |
| **FI** | bmad-forge-idea | Pressure-test a half-formed idea |
| **PC** | bmad-project-context | Set up AGENTS.md for this repo |
| **PM** | bmad-party-mode | Multi-agent discussion |
| **PRD** | bmad-prd | Create/update PRD |
| **QA** | bmad-qa-generate-e2e-tests | Generate API/E2E tests |
| **RS** | bmad-deep-recon | Decision-grade research |
| **RV** | bmad-review | Tighten any draft |
| **SP** | bmad-sprint-planning | Readiness gate + status file |
| **SPC** | bmad-spec | Distill messy input into SPEC.md |
| **SS** | bmad-sprint-planning (status) | Quick status summary |
| **WB** | bmad-prfaq | Working Backwards concept test |
| **AE** | bmad-advanced-elicitation | Deeper critique of a draft |
| **BC** | bmad-customize | Change agent/workflow behavior |
| **BD** | bmad-build | **Implement the next story** ← you are here |

---

## 💡 Tips for Using the Map

1. **Always run skills in a fresh context window** for best results.
2. **One skill per turn** — don't stack multiple skills in one session.
3. **Required ≠ optional** — required rows are gates; optional rows are helpful but skippable.
4. **Phase progression** — top to bottom is roughly the natural order, but you can jump to "anytime" rows freely.
5. **Update this map** — if you discover a new trigger/skill pattern that helps you, add it.

---

*Generated for appoinment managment system • BMad 6.11.0 • Modules: core, bmm*
