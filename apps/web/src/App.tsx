/**
 * App entry — E1-S0-ui.
 *
 * Renders the admin shell + the Clinic Settings page. The web app has no
 * router today; the active admin section is hard-coded to `clinic` until
 * the next admin page lands. Other admin sections are visible in the
 * shell as disabled buttons (per mockup 32).
 *
 * The page is fully wired to `GET /admin/clinic` and `PATCH /admin/clinic`
 * via the dev-mode `x-auth-claim` header. The Vite dev server proxies
 * `/admin/*` to the API on :3001 (see vite.config.ts).
 */
import { AppShell } from './AppShell';
import { ClinicSettings } from './pages/ClinicSettings';

export function App() {
  return (
    <AppShell active="clinic">
      <ClinicSettings />
    </AppShell>
  );
}
