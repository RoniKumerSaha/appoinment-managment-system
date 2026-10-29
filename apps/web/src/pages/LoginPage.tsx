/**
 * LoginPage — the dispatcher for the three login screens.
 *
 * The login is now SPLIT into three screens rather than one page
 * with two cards on it:
 *
 *   `#/login`          → LoginChooser    (the root's landing screen)
 *   `#/login/staff`    → StaffLoginPage  (role + email + password)
 *   `#/login/patient`  → PatientLoginPage (phone + 6-digit OTP)
 *
 * The split matters because the two audiences share nothing: a
 * patient has no business seeing a role dropdown and a staff member
 * has no business seeing an OTP widget. On a narrow screen the old
 * two-up layout stacked them, so each audience scrolled past the
 * other's form first.
 *
 * This component only picks the screen — the routes live in
 * `login-routes.ts` and the screens themselves own their forms.
 *
 * `App.tsx` renders this whenever there is no authenticated session.
 */
import { LoginChooser } from './LoginChooser';
import { PatientLoginPage } from './PatientLoginPage';
import { StaffLoginPage } from './StaffLoginPage';
import { useLoginRoute } from './login-routes';

export function LoginPage() {
  const route = useLoginRoute();

  if (route === 'staff') return <StaffLoginPage />;
  if (route === 'patient') return <PatientLoginPage />;
  return <LoginChooser />;
}
