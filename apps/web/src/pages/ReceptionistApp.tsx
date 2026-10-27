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
 *
 * The availability browser hands its chosen slot to the create flow
 * (mock 16 → mock 14): the create page opens pre-filled with the
 * doctor, type, date and slot.
 */
import { useCallback, useEffect, useState } from 'react';
import { ReceptionistToday } from './ReceptionistToday';
import { ReceptionistCancel } from './ReceptionistCancel';
import { ReceptionistCreate } from './ReceptionistCreate';
import { ReceptionistAvailability } from './ReceptionistAvailability';

type RecepView = 'today' | 'cancel' | 'create' | 'availability';

interface SlotPrefill {
  doctor_id: string;
  appointment_type_id: string;
  date: string;
  start_datetime: string;
  end_datetime: string;
}

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
  const [prefill, setPrefill] = useState<SlotPrefill | undefined>(undefined);

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

  const onOpenCreate = useCallback((): void => {
    setPrefill(undefined);
    setView('create');
  }, []);

  const onOpenAvailability = useCallback((): void => {
    setView('availability');
  }, []);

  const onBookSlot = useCallback((slot: SlotPrefill): void => {
    setPrefill(slot);
    setView('create');
  }, []);

  if (view === 'today') {
    return (
      <ReceptionistToday
        onOpenCancel={onOpenCancel}
        onOpenCreate={onOpenCreate}
        onOpenAvailability={onOpenAvailability}
      />
    );
  }
  if (view === 'create') {
    return <ReceptionistCreate prefill={prefill} />;
  }
  if (view === 'availability') {
    return <ReceptionistAvailability onBookSlot={onBookSlot} />;
  }
  return (
    <ReceptionistCancel
      preselectedAppointmentId={preselectedId}
      onBackToToday={onBackToToday}
    />
  );
}
