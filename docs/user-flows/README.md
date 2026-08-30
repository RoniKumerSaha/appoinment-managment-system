# Real User Flows

Persona-driven journey flows for each role. Where `docs/UX-FLOWS.md` is the **system's** view (validations, atomicity, audit), this folder is the **person's** view (what they see, decide, and feel across a real working day).

| Role | Persona | File |
|---|---|---|
| Patient | Fatima — working mother, books between meetings | [`patient.md`](./patient.md) |
| Doctor | Dr. Ahmed Al-Rashid — cardiologist, 18 years | [`doctor.md`](./doctor.md) |
| Receptionist | Reem — front desk, Riyadh Olaya branch | [`receptionist.md`](./receptionist.md) |
| Administrator | Salem — operations manager, 4 branches | [`admin.md`](./admin.md) |

Each persona file follows the same structure:

1. **Scenario** — one realistic working-day-or-event narrative
2. **Acts** — chronologically ordered moments in the persona's day
3. **What they never see** — the system complexity the UI hides from them
4. **Edge cases** — what disrupts the journey and how the system responds
5. **Open UX questions** — design decisions still pending

## How to use

- **Design review:** Walk the persona through the acts. Does each screen feel like a step they'd actually take?
- **Stakeholder demo:** Pick one persona (e.g. Fatima) and read their story aloud before showing the screens.
- **Copy review:** Each file calls out specific copy strings (toasts, modal text). If those need to change, the change lives here.
- **Edge-case triage:** The "Edge cases" table at the end of each file is a checklist for QA. Every cell should be exercised in test plans.

## Source

These flow from the existing artifacts:

- `docs/PRD.md` — functional & non-functional requirements
- `docs/BRD.md` — business rules
- `docs/UX-FLOWS.md` — system flows (F-01 through F-19)
- `docs/mockups/v1/winners/` — 19 selected screen designs

The real user flow tells you **what it feels like** to live inside those rules. The system flow tells you **what the rules actually are**. Both are needed.