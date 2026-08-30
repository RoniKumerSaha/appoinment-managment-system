# Mockup v1 — UX Flow Mockups

Static HTML/CSS mockups for the Multi-Branch Clinic Appointment Scheduling System.

## How to use

**For stakeholder walkthrough:** Open `app/index.html` — a connected application shell that lets you click through every flow as if it were a real app. Role switcher jumps between Patient / Doctor / Receptionist / Admin / Landing.

**For stakeholder review:** Open `mocks.html` — a single scrollable page showing all 19 winners as thumbnails, with filter + search + grid-size controls.

## Conventions

- **Color**: Clinical Calm teal — `#0f766e` (primary), `#f0fdfa` (light), `#99f6e4` (border)
- **Default layout**: Sidebar `1fr 320px` with summary; stacked `760px` center without
- **Stacked Vertical Flow is the default pattern** when there's no specific reason to deviate
- **ConflictModal** = 3-part pattern (what happened / why / what you can do)
- **Atomicity cue** = "Atomic: `<op>`" + "audit: `<event>`" inline

## Directory layout

```
docs/mockups/v1/
├── README.md                        ← you are here
├── mocks.html                       ← stakeholder overview (all 19 winners as thumbnails)
├── CHOICES.md                       ← selection state (resume from here)
│
├── app/                             ← connected app walkthrough
│   ├── index.html                   ← shell entry point
│   ├── shell.css                    ← topbar + responsive styles
│   ├── shell.js                     ← hash router + 20 routes + cross-link interception
│   └── logo.svg                     ← Logo 03 · Monoline Icon (selected winner)
│
├── winners/                         ← 19 selected mockups + 1 selected logo
│   ├── 01-layout-direction.html     ← A · Clinical Calm + Sidebar
│   ├── 02-doctor-picker.html        ← E · Card-First + Sidebar
│   ├── 03-availability-calendar.html ← E · Agenda Timeline
│   ├── 04-patient-confirm.html      ← E · Stacked Vertical Flow
│   ├── 05-patient-self-service.html ← E · Stacked Vertical Flow
│   ├── 06-resolve-affected.html     ← C · Kanban Queue
│   ├── 07-recurring-preview.html    ← E · Stacked Vertical Flow
│   ├── 08-branch-hours-impact.html  ← E · Stacked Vertical Flow
│   ├── 09-doctor-schedule.html      ← B · List by Day + Tabs
│   ├── 10-doctor-block-time.html    ← E · Stacked Vertical Flow
│   ├── 11-appointment-types.html    ← E · Stacked Vertical Flow
│   ├── 12-mark-status.html          ← D · Quick-Action Sidebar
│   ├── 13-recep-today.html          ← D · Card List by Hour
│   ├── 14-recep-create.html         ← A · Stepped Form
│   ├── 15-recep-cancel.html         ← E · Stacked Vertical Flow
│   ├── 16-recep-availability.html   ← E · Stacked Vertical Flow
│   ├── 17-admin-branches.html       ← E · Stacked Vertical Flow
│   ├── 18-admin-doctors.html        ← B · Card Grid
│   └── 19-admin-receptionists.html  ← B · Card Grid
│
└── logos/
    └── selected-logo-monoline-icon.html  ← Logo 03 · Monoline Icon
```

## Connected app shell

Open `app/index.html` for a clickable walk-through of every flow:

- Topbar shows current actor + breadcrumb (computed from the route table)
- Role switcher jumps to each actor's home route
- "Open in new tab" anchor opens the current iframe URL
- URL hash `#/path` is shareable (e.g. `#/doctor/today` opens the doctor's mark-status view)
- Cross-link cues (e.g. "Book another", "← Schedule editor", "+ New appointment") are intercepted and route between mockups
- The demo `.badge` corner tag is hidden inside the shell — re-shown when you open a mockup standalone

20 routes total: 1 landing + 5 patient + 6 doctor + 4 receptionist + 4 admin.

## Parts

| # | Flow ID | Actor | Flow | Pick |
|---|---------|-------|------|------|
| 01 | — | — | Layout direction | A |
| 02 | F-02 | Patient | Doctor/Branch/Type picker | E |
| 03 | F-02/F-15 | Patient | Availability calendar | E |
| 04 | F-03 | Patient | Patient details + confirmation | E |
| 05 | F-04/F-05 | Patient | Self-service (OTP + my appts) | E |
| 06 | F-09 | Doctor/Patient | Resolve affected appointments | C |
| 07 | F-11 | Patient | Recurring series preview | E |
| 08 | F-17 | Admin/Doctor | Branch hours change affected | E |
| 09 | F-06 | Doctor | Schedule editor | B |
| 10 | F-07 | Doctor | Block dates / periods | E |
| 11 | F-08 | Doctor | Manage appointment types | E |
| 12 | F-10 | Doctor | Cancel / mark status | D |
| 13 | F-12 | Receptionist | Today's branch view | D |
| 14 | F-13 | Receptionist | Create appointment on behalf | A |
| 15 | F-14 | Receptionist | Cancel appointment | E |
| 16 | F-15 | Receptionist | View doctor availability | E |
| 17 | F-16 | Admin | Manage branches | E |
| 18 | F-18 | Admin | Manage doctors | B |
| 19 | F-19 | Admin | Manage receptionists | B |

## Logo

| # | Pick | File |
|---|------|------|
| Logo | **03 · Monoline Icon** | `logos/selected-logo-monoline-icon.html` · SVG mirror at `app/logo.svg` |

## Resume protocol

All 19 parts + logo complete. 🎉 See `CHOICES.md` for the final pattern picks + pattern tally. App shell at `app/index.html` ties everything together for stakeholder demos.