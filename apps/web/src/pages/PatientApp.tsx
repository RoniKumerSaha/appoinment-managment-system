/**
 * PatientApp — top-level patient container (W59 deferral: internal router).
 *
 * Mirrors the receptionist pattern (ReceptionistApp): a tiny view-state
 * machine that switches between the booking flow (E3-ui) and the
 * self-service hub (E4-S1 + E4-S2 + E4-S3 + E4-S4 ui).
 *
 *  - 'find-doctor' → <PatientBooking /> (the 5-step E3 flow)
 *  - 'my-appointments' → <MyAppointments onGoFindDoctor={…} />
 *
 * Both views render inside the shared `PatientFrame`. The frame's
 * `activeLink` and `onNavigate` props mirror the view state.
 *
 * E4-S4 deep-link landing: if the patient arrived via a deep link
 * (`?action=cancel|reschedule&id=<uuid>`), we probe the appointment
 * and pre-open the matching surface. After handling, the URL is
 * scrubbed via `history.replaceState` so the browser back button
 * doesn't re-trigger.
 *
 * No tests in this pass (per user instruction).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PatientBooking } from './PatientBooking';
import { MyAppointments } from './MyAppointments';

type PatientView = 'find-doctor' | 'my-appointments';

interface PatientAppProps {
  initialView?: PatientView;
  initialAction?: 'cancel' | 'reschedule';
  initialAppointmentId?: string;
}

function readQuery(): {
  action?: 'cancel' | 'reschedule';
  id?: string;
} {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  const rawAction = params.get('action');
  const rawId = params.get('id') ?? undefined;
  const action: 'cancel' | 'reschedule' | undefined =
    rawAction === 'cancel' || rawAction === 'reschedule'
      ? rawAction
      : undefined;
  return { action, id: rawId };
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
  // the URL once for a deep-link (E4-S4) — the MyAppointments page
  // also reads the URL, but doing it here lets us surface the deep
  // link even when the initial render is on find-doctor.
  const deepLinkFromProps = useMemo(() => {
    if (initialAction && initialAppointmentId) {
      return { action: initialAction, id: initialAppointmentId };
    }
    return null;
  }, [initialAction, initialAppointmentId]);

  const deepLinkFromUrl = useMemo(() => {
    if (deepLinkFromProps) return null;
    const q = readQuery();
    if (q.action && q.id) return { action: q.action, id: q.id };
    return null;
  }, [deepLinkFromProps]);

  // We hand the deep-link target down to MyAppointments when the
  // patient lands via a deep link from find-doctor.
  useEffect(() => {
    if (deepLinkFromUrl) {
      // Scrub the URL early so a back navigation doesn't re-trigger.
      scrubQuery();
      setView('my-appointments');
    }
  }, [deepLinkFromUrl]);

  const onNavigate = useCallback((link: PatientView) => {
    setView(link);
  }, []);

  if (view === 'my-appointments') {
    return (
      <MyAppointments
        initialAction={deepLinkFromProps?.action ?? deepLinkFromUrl?.action}
        initialAppointmentId={
          deepLinkFromProps?.id ?? deepLinkFromUrl?.id
        }
        onGoFindDoctor={() => {
          onNavigate('find-doctor');
        }}
      />
    );
  }

  return <PatientBooking />;
}