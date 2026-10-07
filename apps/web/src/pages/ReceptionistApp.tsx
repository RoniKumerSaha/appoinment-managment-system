/**
 * ReceptionistApp — receptionist role router.
 *
 * The receptionist has a smaller surface than the admin AppShell
 * (mockups 13 / 15 / 26): today view + cancel view. We add two new
 * walk-in surfaces reachable via `?page=create|availability` so
 * the missing mockups (14, 16) are demoable without touching the
 * existing today view.
 *
 *  - 'today'         → ReceptionistToday
 *  - 'cancel'        → ReceptionistCancel (with optional preselected appt)
 *  - 'create'        → ReceptionistCreate       (mock 14)
 *  - 'availability'  → ReceptionistAvailability (mock 16)
 *
 * `onBackToToday` returns to the today view. `onOpenCancel` from
 * the today view navigates to cancel with the preselected appt.
 */
import { useCallback, useEffect, useState } from 'react';
import { ReceptionistToday } from './ReceptionistToday';
import { ReceptionistCancel } from './ReceptionistCancel';
import { ReceptionistCreate } from './ReceptionistCreate';
import { ReceptionistAvailability } from './ReceptionistAvailability';

type RecepView = 'today' | 'cancel' | 'create' | 'availability';

function readPageParam(): RecepView | null {
  if (typeof window === 'undefined') return null;
  const raw = new URLSearchParams(window.location.search).get('page');
  if (raw === 'create' || raw === 'availability') return raw;
  return null;
}

export function ReceptionistApp() {
  const [view, setView] = useState<RecepView>('today');
  const [preselectedId, setPreselectedId] = useState<string | undefined>(
    undefined,
  );

  useEffect(() => {
    const v = readPageParam();
    if (v !== null) setView(v);
  }, []);

  const onOpenCancel = useCallback((appointmentId: string): void => {
    setPreselectedId(appointmentId === '' ? undefined : appointmentId);
    setView('cancel');
  }, []);

  const onBackToToday = useCallback((): void => {
    setView('today');
    setPreselectedId(undefined);
  }, []);

  if (view === 'today') {
    return <ReceptionistToday onOpenCancel={onOpenCancel} />;
  }
  if (view === 'create') {
    return <ReceptionistCreate />;
  }
  if (view === 'availability') {
    return <ReceptionistAvailability />;
  }
  return (
    <ReceptionistCancel
      preselectedAppointmentId={preselectedId}
      onBackToToday={onBackToToday}
    />
  );
}