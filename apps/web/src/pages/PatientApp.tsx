/**
 * PatientApp — top-level patient container (W59 deferral: internal router).
 *
 * Mirrors the receptionist pattern (ReceptionistApp): a tiny view-state
 * machine that switches between the booking flow (E3-ui) and the
 * self-service hub (E4-S1 + E4-S2 + E4-S3 + E4-S4 ui).
 *
 *  - 'find-doctor' → <PatientBooking /> (the 5-step E3 flow)
 *  - 'my-appointments' → <MyAppointments onGoFindDoctor={…} />
 *  - 'cancel-occurrence' → <RecurringOccurrenceCancel /> (mock 33)
 *
 * The confirmation receipt (mock 36) is not a route of its own — it
 * is the terminal state of the booking flow inside `PatientBooking`,
 * rendered from the booking that was actually made.
 *
 * E4-S2 deep-link landing: if the patient arrived via a deep link
 * (`?action=cancel|reschedule&id=<uuid>`), we probe the appointment
 * and pre-open the matching surface. After handling, the URL is
 * scrubbed via `history.replaceState` so the browser back button
 * doesn't re-trigger. The cancel-occurrence screen is also
 * reachable via `?page=cancel-occurrence`.
 */
import { useCallback, useEffect, useState } from 'react';
import { PatientBooking } from './PatientBooking';
import { MyAppointments } from './MyAppointments';
import { RecurringOccurrenceCancel } from './RecurringOccurrenceCancel';

type PatientView = 'find-doctor' | 'my-appointments' | 'cancel-occurrence';

interface PatientAppProps {
  initialView?: PatientView;
  initialAction?: 'cancel' | 'reschedule';
  initialAppointmentId?: string;
}

interface DeepLink {
  action?: 'cancel' | 'reschedule';
  id?: string;
  page?: PatientView;
}

function readQuery(): DeepLink {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  const rawAction = params.get('action');
  const rawId = params.get('id') ?? undefined;
  const rawPage = params.get('page');
  const action: 'cancel' | 'reschedule' | undefined =
    rawAction === 'cancel' || rawAction === 'reschedule'
      ? rawAction
      : undefined;
  const page: PatientView | undefined =
    rawPage === 'cancel-occurrence' ? rawPage : undefined;
  return { action, id: rawId, page };
}

function scrubQuery(): void {
  if (typeof window === 'undefined') return;
  try {
    window.history.replaceState({}, '', window.location.pathname);
  } catch {
    // ignore
  }
}

export function PatientApp({
  initialView,
  initialAction,
  initialAppointmentId,
}: PatientAppProps) {
  const [view, setView] = useState<PatientView>(initialView ?? 'find-doctor');

  // If the caller already passed an initial action, honour it by
  // jumping to my-appointments. Otherwise, on first mount, inspect
  // the URL once for a deep-link (E4-S2) — the MyAppointments page
  // also reads the URL, but doing it here lets us surface the deep
  // link even when the initial render is on find-doctor.
  //
  // Important: this is captured into `useState` so it is computed
  // *exactly once* on mount. If we re-evaluated the IIFE on every
  // render, the second render (triggered by `setView` after
  // `scrubQuery()`) would see the now-empty URL and lose the
  // action/id that we need to hand to <MyAppointments>.
  const [deepLink] = useState<DeepLink>(() => {
    if (initialAction && initialAppointmentId) {
      return { action: initialAction, id: initialAppointmentId } as DeepLink;
    }
    return readQuery();
  });

  useEffect(() => {
    if (deepLink.page) {
      scrubQuery();
      setView(deepLink.page);
    } else if (deepLink.action && deepLink.id) {
      scrubQuery();
      setView('my-appointments');
    }
    // Run only once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onNavigate = useCallback((link: PatientView) => {
    setView(link);
  }, []);

  if (view === 'cancel-occurrence') {
    return <RecurringOccurrenceCancel />;
  }
  if (view === 'my-appointments') {
    return (
      <MyAppointments
        initialAction={deepLink.action}
        initialAppointmentId={deepLink.id}
        onGoFindDoctor={() => {
          onNavigate('find-doctor');
        }}
      />
    );
  }

  return <PatientBooking onNavigate={onNavigate as (link: 'find-doctor' | 'my-appointments') => void} />;
}