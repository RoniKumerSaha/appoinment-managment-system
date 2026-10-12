/**
 * e2e/fixtures.ts — re-export Playwright's `test` with a `role` fixture.
 *
 * Spec files import `test` from here (not from `@playwright/test`).
 * Setting `test.use({ storageState: 'e2e/.auth/<role>.json' })` inside
 * a spec file is the standard Playwright pattern; this module exists
 * so future role-based helpers (e.g. a typed `loginAs` action) can
 * be added without touching every spec.
 *
 * Today: passthrough re-export. Tomorrow: add a `role` fixture if
 * more than the `storageState` shorthand is needed.
 */
export { test, expect } from '@playwright/test';
