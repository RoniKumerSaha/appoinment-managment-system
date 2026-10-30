/**
 * App entry — E1-S0-ui + W10 + W59.
 *
 * W59 update: the AppShell now reads its `active` section + sub-page
 * from the URL (via `usePathRoute`) instead of a local useState. The
 * URL is the source of truth. Anchor tags inside admin pages can use
 * `<Link to="/admin/branches">` for client-side navigation; bare
 * `<a href="/admin/...">` tags still work — the page loader on first
 * mount parses the URL the same way.
 *
 * W10 update: the shell is only rendered when there is a valid
 * authenticated session. Otherwise the LoginPage takes over. On app boot
 * we POST `/auth/me` once with the token from localStorage to confirm it
 * hasn't been invalidated since the last visit; on 401 the auth store is
 * cleared and the LoginPage renders.
 *
 * The LoginPage is a dispatcher over THREE screens — the chooser
 * (`#/login`), the staff form (`#/login/staff`) and the patient form
 * (`#/login/patient`). See `pages/login-routes.ts`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AppShell,
  type AdminSection,
  type AdminSubPage,
} from './AppShell';
import { AdminBranches } from './pages/AdminBranches';
import { AdminBranchHours } from './pages/AdminBranchHours';
import { AdminReceptionists } from './pages/AdminReceptionists';
import { AdminDoctors } from './pages/AdminDoctors';
import { AdminDoctorAssign } from './pages/AdminDoctorAssign';
import { AdminDoctorSchedule } from './pages/AdminDoctorSchedule';
import { AdminDoctorBlocks } from './pages/AdminDoctorBlocks';
import { AdminAppointmentTypes } from './pages/AdminAppointmentTypes';
import { PatientApp } from './pages/PatientApp';
import { ReceptionistApp } from './pages/ReceptionistApp';
import { DoctorApp } from './pages/DoctorApp';
import { LoginPage } from './pages/LoginPage';
import { useAuth, logout } from './auth/store';
import { setOnUnauthorized, getMe, ApiError } from './api/client';
import {
  buildPath,
  usePathRoute,
  DEFAULT_PATH,
} from './router/usePathRoute';

export function App() {
  const { stored, isAuthenticated, expired } = useAuth();
  const role = stored?.claim.role ?? null;
  const [bootStatus, setBootStatus] = useState<'checking' | 'ok' | 'fail'>(
    'checking',
  );
  const { route, navigate } = usePathRoute();

  // Wire the 401-triggered auth-clear at app boot. The store is the
  // single source of truth; the client just publishes events.
  //
  // This calls `logout()` rather than `clearAuth()` because the
  // session can expire while the user is ON a login screen — the
  // patient URL is `#/login/patient`, so without the URL reset the
  // app would drop straight back to the patient form instead of the
  // chooser.
  useEffect(() => {
    setOnUnauthorized(() => {
      logout();
    });
    return () => setOnUnauthorized(null);
  }, []);

  // On boot, if we have a stored token, confirm it is still valid via
  // GET /auth/me. If the call 4xxs, clear and show LoginPage.
  //
  // These use `logout()` rather than `clearAuth()` so the URL is
  // reset to the chooser too — otherwise an expired session on
  // `#/login/patient` would land back on the patient form.
  useEffect(() => {
    if (stored === null) {
      setBootStatus('ok');
      return;
    }
    if (expired) {
      logout();
      setBootStatus('ok');
      return;
    }
    getMe()
      .then(() => {
        setBootStatus('ok');
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          logout();
        }
        // For any other error (network down, 500), keep the session and
        // let the inner page surface the error itself.
        setBootStatus('ok');
      });
  }, [stored, expired]);

  // On first admin mount, if the URL is empty/root or doesn't match
  // any known admin route, redirect to the default.
  useEffect(() => {
    if (!isAuthenticated) return;
    if (role !== null && role !== 'admin') return;
    if (route.kind === 'unknown') {
      navigate(DEFAULT_PATH);
    }
  }, [isAuthenticated, role, route.kind, navigate]);

  // Derive the active section + sub from the parsed route.
  const { active, sub } = useMemo(() => {
    if (route.kind === 'admin-top') {
      return { active: route.section, sub: null as AdminSubPage | null };
    }
    if (route.kind === 'admin-sub') {
      return { active: route.section, sub: route.sub };
    }
    return {
      active: 'branches' as AdminSection,
      sub: null as AdminSubPage | null,
    };
  }, [route]);

  const onNavigate = useCallback(
    (section: AdminSection) => {
      navigate(buildPath(section));
    },
    [navigate],
  );

  const onOpenBranchHours = useCallback(
    (branchId: string) => {
      navigate(buildPath('branches', { key: 'branch-hours', branchId }));
    },
    [navigate],
  );

  const onOpenDoctorAssign = useCallback(
    (doctorId: string) => {
      navigate(buildPath('doctors', { key: 'doctor-assign', doctorId }));
    },
    [navigate],
  );

  const onOpenDoctorSchedule = useCallback(
    (doctorId: string) => {
      navigate(buildPath('doctors', { key: 'doctor-schedule', doctorId }));
    },
    [navigate],
  );

  const onOpenDoctorBlocks = useCallback(
    (doctorId: string) => {
      navigate(buildPath('doctors', { key: 'doctor-blocks', doctorId }));
    },
    [navigate],
  );

  const onBackToBranches = useCallback(() => {
    navigate(buildPath('branches'));
  }, [navigate]);

  const onBackToDoctors = useCallback(() => {
    navigate(buildPath('doctors'));
  }, [navigate]);

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

  // Patient session bypasses the admin shell and renders the patient
  // booking flow directly (E3-ui). Receptionist sessions bypass
  // the admin shell and render the receptionist dashboard (E5-S4 /
  // E5-S3). Staff (admin/doctor) continue to use the admin AppShell.
  if (role === 'patient') {
    return <PatientApp />;
  }
  if (role === 'receptionist') {
    return <ReceptionistApp />;
  }
  if (role === 'doctor') {
    return <DoctorApp />;
  }

  return (
    <AppShell active={active} onNavigate={onNavigate}>
      {sub?.key === 'branch-hours' && (
        <AdminBranchHours
          branchId={sub.branchId}
          onBackToBranches={onBackToBranches}
        />
      )}
      {sub?.key === 'doctor-assign' && (
        <AdminDoctorAssign
          doctorId={sub.doctorId}
          onBackToDoctors={onBackToDoctors}
        />
      )}
      {sub?.key === 'doctor-schedule' && (
        <AdminDoctorSchedule
          doctorId={sub.doctorId}
          onBackToDoctors={onBackToDoctors}
        />
      )}
      {sub?.key === 'doctor-blocks' && (
        <AdminDoctorBlocks
          doctorId={sub.doctorId}
          onBackToDoctors={onBackToDoctors}
        />
      )}
      {!sub && active === 'branches' && (
        <AdminBranches onOpenBranchHours={onOpenBranchHours} />
      )}
      {!sub && active === 'doctors' && (
        <AdminDoctors
          onOpenDoctorAssign={onOpenDoctorAssign}
          onOpenDoctorSchedule={onOpenDoctorSchedule}
          onOpenDoctorBlocks={onOpenDoctorBlocks}
        />
      )}
      {!sub && active === 'receptionists' && <AdminReceptionists />}
      {!sub && active === 'types' && <AdminAppointmentTypes />}
    </AppShell>
  );
}