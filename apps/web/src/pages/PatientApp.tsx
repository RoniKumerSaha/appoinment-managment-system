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
 *
 * ── URL-driven navigation ─────────────────────────────────────
 *
 * The patient nav used to be the ONLY one of the four role surfaces
 * that was NOT driven by the URL: `onNavigate` was a bare
 * `setView(link)`, so the patient's section was invisible to the
 * address bar. That meant no deep link (you could not share
 * "my appointments" with yourself), no reload persistence (a refresh
 * on "My appointments" snapped back to "Find a doctor"), and no
 * browser Back button (there was no history entry to go back to).
 *
 * The section now lives in the hash, exactly like the doctor
 * (`#/doctor?page=today`) and the receptionist (`#/reception?page=
 * create`): `#/patient?page=find-doctor` / `?page=my-appointments`.
 */
import { useCallback, useEffect, useState } from 'react';
import { PatientBooking } from './PatientBooking';
import { MyAppointments } from './MyAppointments';
import { RecurringOccurrenceCancel } from './RecurringOccurrenceCancel';
import { readDeepLinkParam, readDeepLinkParams, useDeepLinkParam } from './deep-link';

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
  // Read from the HASH fragment, not `location.search` — the routes
  // are hash-based (`#/patient?page=cancel-occurrence`), so the query
  // string lives inside the fragment and `location.search` is always
  // empty.
  const params = readDeepLinkParams();
  const rawAction = params.get('action');
  const rawId = params.get('id') ?? undefined;
  const rawPage = params.get('page');
  const action: 'cancel' | 'reschedule' | undefined =
    rawAction === 'cancel' || rawAction === 'reschedule'
      ? rawAction
      : undefined;
  // `?page=` names a SECTION the patient can be on. Only
  // `cancel-occurrence` needs the one-shot treatment (it is a
  // deep-link landing, not a nav destination), so the other two
  // sections are handled by the URL-driven effect below.
  const page: PatientView | undefined =
    rawPage === 'cancel-occurrence' ? rawPage : undefined;
  return { action, id: rawId, page };
}

/**
 * Strip the ONE-SHOT deep-link params from the URL.
 *
 * `?action=cancel|reschedule&id=<uuid>` is a one-shot instruction:
 * it must fire exactly once, and the browser Back button must not be
 * able to replay it. So it is scrubbed out of the URL.
 *
 * `?page=…` is NOT one-shot — it is the section selector, and it has
 * to SURVIVE the scrub. Dropping it would strip the section from the
 * URL and break the reload-persistence the patient nav was just
 * given (a refresh on "My appointments" would land back on "Find a
 * doctor" with a bare `#/patient` in the address bar).
 */
function scrubQuery(): void {
  if (typeof window === 'undefined') return;
  try {
    // Keep the HASH — the patient app routes on it, and dropping it
    // would reset the view on every scrub.
    const { pathname, hash } = window.location;
    const qIndex = hash.indexOf('?');
    const cleanHash = qIndex === -1 ? hash : hash.slice(0, qIndex);
    const page = readDeepLinkParam('page');
    const next = page === null ? cleanHash : `${cleanHash}?page=${page}`;
    window.history.replaceState({}, '', `${pathname}${next}`);
  } catch {
    // ignore
  }
}

/** The section keys the nav can name in the URL. */
function toPatientView(raw: string | null): PatientView | null {
  if (
    raw === 'find-doctor' ||
    raw === 'my-appointments' ||
    raw === 'cancel-occurrence'
  ) {
    return raw;
  }
  return null;
}

/** Write the current section into the URL. */
function pushView(view: PatientView): void {
  if (typeof window === 'undefined') return;
  const next = `#/patient?page=${view}`;
  if (window.location.hash !== next) window.location.hash = next;
}

export function PatientApp({
  initialView,
  initialAction,
  initialAppointmentId,
}: PatientAppProps) {
  // The section starts from the URL when the URL names one, so a
  // reload on `#/patient?page=my-appointments` opens on "My
  // appointments" rather than snapping back to "Find a doctor".
  //
  // The initial state is read ONCE (the lazy `useState` initializer).
  // A `[view]`-driven "keep the URL in step" effect would clobber
  // the deep link instead: on the first render `view` was still the
  // default, so it would REPLACE the hash with `#/patient?page=
  // find-doctor` before the URL-driven effect had a chance to apply
  // it — and that replacement fires a `hashchange`, which then
  // re-read the now-wrong URL. The URL is the source of truth, so it
  // seeds the state rather than the other way round.
  const [view, setView] = useState<PatientView>(() => {
    if (initialView) return initialView;
    const fromUrl = toPatientView(readDeepLinkParam('page'));
    return fromUrl ?? 'find-doctor';
  });

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

  // `?page=…` is a VIEW selector (e.g. `my-appointments`), so it
  // must follow the URL — a hash-only navigation doesn't remount this
  // component, so a mount-only effect would miss it. The
  // `action`/`id` pair above stays one-shot on purpose: `scrubQuery()`
  // wipes the URL so the back button can't re-trigger the action.
  const pageParam = useDeepLinkParam('page');
  useEffect(() => {
    const v = toPatientView(pageParam);
    if (v !== null) setView(v);
  }, [pageParam]);

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

  // Navigation writes the section into the hash, exactly like the
  // doctor / receptionist navs. That gives the patient surface the
  // same three properties the others have: a shareable deep link,
  // reload persistence, and a working browser Back button.
  //
  // The hash is ASSIGNED (not replaced), so a nav click pushes a
  // history entry and the browser Back button walks the sections.
  const onNavigate = useCallback((link: PatientView) => {
    setView(link);
    pushView(link);
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