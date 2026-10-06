/**
 * ReceptionistApp — receptionist role router.
 *
 * The receptionist has a smaller surface than the admin AppShell
 * (mockups 13 / 15 / 26): two views (today, cancel) plus a future
 * walk-in surface. We use internal sub-state instead of a real
 * router (W59 deferral), keyed on `view`.
 *
 *  - 'today'  → ReceptionistToday
 *  - 'cancel' → ReceptionistCancel (with optional preselected appt)
 *
 * `onBackToToday` returns to the today view. `onOpenCancel` from
 * the today view navigates to cancel with the preselected appt.
 */
import { useCallback, useState } from 'react';
import { ReceptionistToday } from './ReceptionistToday';
import { ReceptionistCancel } from './ReceptionistCancel';

type RecepView = 'today' | 'cancel';

export function ReceptionistApp() {
  const [view, setView] = useState<RecepView>('today');
  const [preselectedId, setPreselectedId] = useState<string | undefined>(
    undefined,
  );

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
  return (
    <ReceptionistCancel
      preselectedAppointmentId={preselectedId}
      onBackToToday={onBackToToday}
    />
  );
}
