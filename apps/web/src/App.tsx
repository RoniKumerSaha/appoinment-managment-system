/**
 * App entry — E1-S0-ui + W10.
 *
 * W10 update: the shell is now only rendered when there is a valid
 * authenticated session. Otherwise the LoginPage takes over. On app boot
 * we POST `/auth/me` once with the token from localStorage to confirm it
 * hasn't been invalidated since the last visit; on 401 the auth store is
 * cleared and the LoginPage renders.
 *
 * The page rendered inside the shell today is the Clinic Settings page
 * (E1-S0-ui). The router lands with the next admin page (deferral W59).
 */
import { useEffect, useState } from 'react';
import { AppShell, type AdminSection } from './AppShell';
import { ClinicSettings } from './pages/ClinicSettings';
import { AdminBranches } from './pages/AdminBranches';
import { LoginPage } from './pages/LoginPage';
import { useAuth, clearAuth } from './auth/store';
import { setOnUnauthorized, getMe, ApiError } from './api/client';

export function App() {
  const { stored, isAuthenticated, expired } = useAuth();
  const [bootStatus, setBootStatus] = useState<'checking' | 'ok' | 'fail'>(
    'checking',
  );
  // Local router stand-in until W59 ships a real router (#22). The
  // nav-state lives here so the AppShell's `onNavigate` callback can
  // flip the page without a full page reload.
  const [active, setActive] = useState<AdminSection>('clinic');

  // Wire the 401-triggered auth-clear at app boot. The store is the
  // single source of truth; the client just publishes events.
  useEffect(() => {
    setOnUnauthorized(() => {
      clearAuth();
    });
    return () => setOnUnauthorized(null);
  }, []);

  // On boot, if we have a stored token, confirm it is still valid via
  // GET /auth/me. If the call 4xxs, clear and show LoginPage.
  useEffect(() => {
    if (stored === null) {
      setBootStatus('ok');
      return;
    }
    if (expired) {
      clearAuth();
      setBootStatus('ok');
      return;
    }
    getMe()
      .then(() => {
        setBootStatus('ok');
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          clearAuth();
        }
        // For any other error (network down, 500), keep the session and
        // let the inner page surface the error itself.
        setBootStatus('ok');
      });
  }, [stored, expired]);

  if (bootStatus === 'checking') {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          background: 'var(--surface-page)',
          color: 'var(--text-muted)',
          fontSize: 'var(--text-sm)',
        }}
      >
        Loading…
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <AppShell active={active} onNavigate={setActive}>
      {active === 'clinic' && <ClinicSettings />}
      {active === 'branches' && <AdminBranches />}
    </AppShell>
  );
}