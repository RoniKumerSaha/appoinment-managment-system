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
import { useCallback, useEffect, useState } from 'react';
import { AppShell, type AdminSection, type AdminSubPage } from './AppShell';
import { ClinicSettings } from './pages/ClinicSettings';
import { AdminBranches } from './pages/AdminBranches';
import { AdminBranchHours } from './pages/AdminBranchHours';
import { AdminReceptionists } from './pages/AdminReceptionists';
import { AdminDoctors } from './pages/AdminDoctors';
import { AdminDoctorAssign } from './pages/AdminDoctorAssign';
import { AdminDoctorSchedule } from './pages/AdminDoctorSchedule';
import { AdminDoctorBlocks } from './pages/AdminDoctorBlocks';
import { AdminAppointmentTypes } from './pages/AdminAppointmentTypes';
import { PatientBooking } from './pages/PatientBooking';
import { LoginPage } from './pages/LoginPage';
import { useAuth, clearAuth } from './auth/store';
import { setOnUnauthorized, getMe, ApiError } from './api/client';

export function App() {
  const { stored, isAuthenticated, expired } = useAuth();
  const role = stored?.claim.role ?? null;
  const [bootStatus, setBootStatus] = useState<'checking' | 'ok' | 'fail'>(
    'checking',
  );
  // Local router stand-in until W59 ships a real router (#22). The
  // nav-state lives here so the AppShell's `onNavigate` callback can
  // flip the page without a full page reload. `sub` is non-null when
  // we're one level below a top-level section (e.g. branch-hours under
  // branches); the AppShell keeps `active='branches'` so the nav still
  // highlights Branches.
  const [active, setActive] = useState<AdminSection>('clinic');
  const [sub, setSub] = useState<AdminSubPage | null>(null);

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

  const onNavigate = useCallback((section: AdminSection) => {
    setActive(section);
    setSub(null); // back to a top-level page when nav changes
  }, []);

  const onOpenBranchHours = useCallback((branchId: string) => {
    setSub({ key: 'branch-hours', branchId });
  }, []);

  const onOpenDoctorAssign = useCallback((doctorId: string) => {
    setSub({ key: 'doctor-assign', doctorId });
  }, []);

  const onOpenDoctorSchedule = useCallback((doctorId: string) => {
    setSub({ key: 'doctor-schedule', doctorId });
  }, []);

  const onOpenDoctorBlocks = useCallback((doctorId: string) => {
    setSub({ key: 'doctor-blocks', doctorId });
  }, []);

  const onBackToBranches = useCallback(() => {
    setSub(null);
  }, []);

  const onBackToDoctors = useCallback(() => {
    setSub(null);
  }, []);

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
  // booking flow directly (E3-ui). Staff (admin/doctor/receptionist)
  // continue to use the admin AppShell.
  if (role === 'patient') {
    return <PatientBooking />;
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
      {!sub && active === 'clinic' && <ClinicSettings />}
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