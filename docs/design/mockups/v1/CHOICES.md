# Mockup v1 — Selection State

**Updated 2026-09-06.** Resume from here next time.

## Pattern tally

| Letter | Pattern | Picks |
|--------|---------|-------|
| **A** | Clinical Calm + Sidebar / Stepped Form | 2 |
| **B** | Card Grid / List by Day + Tabs | 3 |
| **C** | Kanban Queue | 1 |
| **D** | Card List by Hour / Quick-Action | 3 |
| **E** | Stacked Vertical Flow | 22 |

**Total picks so far: 31 / 31 mockups + 1 / 10 logos** — all UX flows and brand covered. 🎉

---

## ✅ Completed picks

| Part | Flow ID | Actor | Flow | Picked option |
|------|---------|-------|------|---------------|
| Part 1 | — | — | Layout direction (home/landing) | **A · Clinical Calm + Sidebar** |
| Part 2 | F-02 | Patient | Doctor/Branch/Type picker | **E · Card-First + Sidebar** |
| Part 3 | F-02 | Patient | Availability calendar | **E · Agenda Timeline** |
| Part 4 | F-03 | Patient | Patient details + confirmation | **E · Stacked Vertical Flow** |
| Part 5 | F-04/F-05 | Patient | Self-service (OTP + my appts) | **E · Stacked Vertical Flow** |
| Part 6 | F-09 | Doctor/Patient | Resolve affected appointments | **C · Kanban Queue** |
| Part 7 | F-11 | Patient | Recurring series preview | **E · Stacked Vertical Flow** |
| Part 8 | F-17 | Admin/Doctor | Branch hours change affected | **E · Stacked Vertical Flow** |
| Part 9 | F-06 | Doctor | Schedule editor | **B · List by Day + Tabs** |
| Part 10 | F-07 | Doctor | Block dates / periods | **E · Stacked Vertical Flow** |
| Part 11 | F-08 | Doctor | Manage appointment types | **E · Stacked Vertical Flow** |
| Part 12 | F-10 | Doctor | Cancel / mark status | **D · List + Quick-Action Sidebar** |
| Part 13 | F-12 | Receptionist | Today's branch view | **D · Card List by Hour** |
| Part 14 | F-13 | Receptionist | Create appointment on behalf | **A · Stepped Form** |
| Part 15 | F-14 | Receptionist | Cancel appointment | **E · Stacked Vertical Flow** |
| Part 16 | F-15 | Receptionist | View doctor availability | **E · Stacked Vertical Flow** |
| Part 17 | F-16 | Admin | Manage branches | **E · Stacked Vertical Flow** |
| Part 18 | F-18 | Admin | Manage doctors | **B · Card Grid** |
| Part 19 | F-19 | Admin | Manage receptionists | **B · Card Grid** |
| Part 20 | F-05 | Patient | Reschedule appointment | **E · Stacked Vertical Flow** |
| Part 21 | F-03 | Patient | OTP verification modal | **E · Stacked Vertical Flow (modal)** |
| Part 22 | F-04 | Patient | Cancel confirmation modal | **E · Stacked Vertical Flow (modal)** |
| Part 23 | F-11 | Doctor | Recurring confirm · 9 of 12 | **E · Stacked Vertical Flow** |
| Part 24 | F-09 | Doctor | Resolve one appointment | **E · Stacked Vertical Flow** |
| Part 25 | F-10 | Doctor | Cancel · reason + audit | **E · Stacked Vertical Flow** |
| Part 26 | F-13 | Recep | Walk-in patient check-in | **D · Quick-Action Stepped** |
| Part 27 | F-20 | Admin | Activity & audit log | **E · Stacked Vertical Flow** |
| Part 28 | F-17 | Admin | Edit operating hours | **E · Stacked Vertical Flow** |
| Part 29 | UX | All | ConflictModal · 4 variants (showcase) | **E · Stacked Vertical Flow** |
| Part 30 | UX | Doctor | Audit log drawer | **E · Stacked Vertical Flow (drawer)** |
| Part 31 | F-18 | Admin | Reassign branches | **E · Stacked Vertical Flow** |

---

## 🎨 Established patterns to keep using

- **Color**: Clinical Calm teal (`#0f766e` primary, `#f0fdfa` light, `#99f6e4` border)
- **Default layout**: Sidebar `1fr 320px` when there's a summary; stacked `760px` center when not
- **Favored structure**: "Stacked Vertical Flow" (numbered sections) — 22 picks, keep it as the default when no specific reason to deviate
- **Conflict pattern**: 3-part ConflictModal — what happened / why / what you can do (showcase: part 29)
- **Atomicity cue**: Use "Atomic: …" + "audit: …" hints in copy where relevant
- **Audit pattern**: AuditLogDrawer for doctor/recep/admin — scope-limited (own appointments / own branch / clinic-structure)

## Notes on pattern deviations

| Part | Picked | Why it deviated from Stacked Flow |
|------|--------|-----------------------------------|
| 1 | A · Clinical Calm + Sidebar | Establishes the global layout direction |
| 6 | C · Kanban Queue | Bulk conflict resolution benefits from column visualization |
| 9 | B · List by Day + Tabs | Multi-period schedule editing needs day-segmentation |
| 12 | D · Quick-Action Sidebar | Doctor needs fast "mark completed / no-show" during consultations |
| 13 | D · Card List by Hour | Receptionist at-a-glance with patient cards grouped by hour |
| 14 | A · Stepped Form | Mirrors F-01 patient flow for symmetry — receptionist creates for patient |
| 18 | B · Card Grid | "People directory" feel with avatar + branch chips + specialty |
| 19 | B · Card Grid | Mirrors Part 18 (doctors) — same role, same pattern for symmetry |
| 26 | D · Quick-Action Stepped | Walk-in needs fast phone→branch→slot flow; mirrors recep create stepped form |

---

## 🎨 Logo

| Pick | Name | File |
|------|------|------|
| **03 · Monoline Icon** | Calendar frame + medical cross + slot dots | `logos/selected-logo-monoline-icon.html` · SVG mirror at `app/logo.svg` |

---

## 📁 Files ready

All files live at `docs/design/mockups/v1/` — see `README.md` for the directory tree.

After the v1 cleanup, all rejected options and legacy folders were deleted. Only winners remain:

- `winners/01-…31-*.html` — 31 selected mockup files
- `logos/selected-logo-monoline-icon.html` — selected logo
- `app/` — connected app shell (`index.html`, `shell.js`, `shell.css`, `standalone-router.js`, `components.html`, `design-system.html`)
- `mocks.html` — stakeholder overview page (31 thumbs + filter + search)
