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
import { useDeepLinkParam } from './deep-link';

type RecepView = 'today' | 'cancel' | 'create' | 'availability';

interface SlotPrefill {
  doctor_id: string;
  appointment_type_id: string;
  date: string;
  start_datetime: string;
  end_datetime: string;
}

function toRecepView(raw: string | null): RecepView | null {
  // Every section in RECEPTIONIST_NAV has to be parseable here, or the
  // nav link that sets it would be ignored and the view would fall
  // back to 'today'. 'cancel' was missing once already (a deep link
  // to the cancel screen silently landed on Today); 'today' was
  // missing too — harmless by accident, because 'today' IS the
  // default, but it meant the URL and the view state could disagree.
  if (
    raw === 'today' ||
    raw === 'create' ||
    raw === 'availability' ||
    raw === 'cancel'
  ) {
    return raw;
  }
  return null;
}

/** Write the current section into the URL. */
function pushView(view: RecepView): void {
  if (typeof window === 'undefined') return;
  const next = `#/reception?page=${view}`;
  if (window.location.hash !== next) window.location.hash = next;
}

export function ReceptionistApp() {
  const [view, setView] = useState<RecepView>('today');
  const [preselectedId, setPreselectedId] = useState<string | undefined>(
    undefined,
  );
  const [prefill, setPrefill] = useState<SlotPrefill | undefined>(undefined);

  // The deep link is read from the HASH fragment, not
  // `location.search` — the routes are hash-based
  // (`#/reception?page=create`), so the query string lives inside
  // the fragment and `location.search` is always empty.
  //
  // This is a REACTIVE read: the app component stays mounted across a
  // hash-only navigation (no remount), so a mount-only effect never
  // re-ran and the view never changed.
  const pageParam = useDeepLinkParam('page');
  useEffect(() => {
    const v = toRecepView(pageParam);
    if (v !== null) setView(v);
  }, [pageParam]);

  const onOpenCancel = useCallback((appointmentId: string): void => {
    setPreselectedId(appointmentId === '' ? undefined : appointmentId);
    setView('cancel');
    pushView('cancel');
  }, []);

  const onBackToToday = useCallback((): void => {
    setView('today');
    setPreselectedId(undefined);
    pushView('today');
  }, []);

  const onOpenCreate = useCallback((): void => {
    setPrefill(undefined);
    setView('create');
    pushView('create');
  }, []);

  const onOpenAvailability = useCallback((): void => {
    setView('availability');
    pushView('availability');
  }, []);

  const onBookSlot = useCallback((slot: SlotPrefill): void => {
    setPrefill(slot);
    setView('create');
    pushView('create');
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
