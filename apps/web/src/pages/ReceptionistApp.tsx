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
 *  - 'series'        → ReceptionistRecurringForm
 *  - 'preview'       → RecurringPreviewPage    (mock 07)
 *  - 'confirm'       → RecurringConfirmPage    (mock 23)
 *
 * `onBackToToday` returns to the today view. `onOpenCancel` from
 * the today view navigates to cancel with the preselected appt.
 *
 * The availability browser hands its chosen slot to the create flow
 * (mock 16 → mock 14): the create page opens pre-filled with the
 * doctor, type, date and slot.
 *
 * ── The recurring series ─────────────────────────────────────
 *
 * The recurring flow is a three-step state machine over the API:
 * the series shape is POSTed to `/recurring/preview`, the returned
 * `preview_id` is POSTed to `/recurring/confirm`, and the response
 * is what the confirm screen renders.
 *
 * The API has ALWAYS allowed a receptionist here — the scope is
 * branch-only (BR-004) and the preview re-checks that the chosen
 * doctor works at that branch (`doctor_not_at_branch`). What was
 * missing was the ENTRY POINT: the flow was mounted only in
 * `DoctorApp`, so the server was more capable than the receptionist's
 * own surface.
 *
 * The state machine itself is shared with the doctor through
 * `useRecurringFlow` — the two surfaces must not drift, because a
 * drift here is a booking bug rather than a cosmetic one. They
 * differ in exactly one thing: the DOCTOR field. A doctor books for
 * themselves and the API binds `doctor_id` to `claim.doctor_id`
 * (403 `outside_branch_scope` otherwise); a receptionist books for
 * any doctor at their branch, so their form has a doctor picker.
 *
 * There is deliberately NO back-out screen here. `RecurringBackOut`
 * reads the series through `GET /doctor/recurring/:seriesId`, which
 * is scoped to the doctor who owns the series, so a receptionist
 * cannot read back a series they booked — and the screen renders in
 * the doctor's frame regardless.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { ReceptionistToday } from './ReceptionistToday';
import { ReceptionistCancel } from './ReceptionistCancel';
import { ReceptionistCreate } from './ReceptionistCreate';
import { ReceptionistAvailability } from './ReceptionistAvailability';
import { ReceptionistRecurringForm } from './ReceptionistRecurringForm';
import { RecurringPreviewPage } from './RecurringPreviewPage';
import { RecurringConfirmPage } from './RecurringConfirmPage';
import { useDeepLinkParam } from './deep-link';
import { useRecurringFlow } from './useRecurringFlow';

type RecepView =
  | 'today'
  | 'cancel'
  | 'create'
  | 'availability'
  | 'series'
  | 'preview'
  | 'confirm';

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
    raw === 'cancel' ||
    raw === 'series' ||
    raw === 'preview' ||
    raw === 'confirm'
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

  // Start each step of the recurring flow at the top of the page.
  //
  // The flow swaps the whole view (form → preview → confirm) inside
  // one mounted component, so the browser keeps the previous step's
  // scroll offset. After "Preview series →" the preview page opened
  // 331px down — the "Series details" heading and its first two rows
  // were already scrolled off the top, which is exactly the content
  // the user clicked to see.
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [view]);

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

  // The recurring flow — shared with the doctor through
  // `useRecurringFlow`. The hook owns the DATA; this component owns
  // the CHROME (which view is on screen, and the URL that names it).
  const goPreview = useCallback((): void => {
    setView('preview');
    pushView('preview');
  }, []);
  const goConfirm = useCallback((): void => {
    setView('confirm');
    pushView('confirm');
  }, []);

  const recurring = useRecurringFlow({
    onPreview: goPreview,
    onConfirm: goConfirm,
  });

  const backToSeries = useCallback((): void => {
    recurring.reset();
    setView('series');
    pushView('series');
  }, [recurring]);

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
  if (view === 'series') {
    return (
      <ReceptionistRecurringForm
        error={recurring.state.error}
        busy={recurring.state.busy}
        onSubmit={recurring.runPreview}
      />
    );
  }
  if (view === 'preview' && recurring.state.preview !== null) {
    return (
      <RecurringPreviewPage
        preview={recurring.state.preview}
        labels={recurring.labels}
        requested={recurring.state.input?.occurrences_or_until_date ?? 0}
        error={recurring.state.error}
        busy={recurring.state.busy}
        onCancel={backToSeries}
        onEditPattern={backToSeries}
        onConfirm={recurring.runConfirm}
        role="receptionist"
      />
    );
  }
  if (view === 'confirm' && recurring.state.result !== null) {
    return (
      <RecurringConfirmPage
        result={recurring.state.result}
        labels={recurring.labels}
        requested={recurring.state.input?.occurrences_or_until_date ?? 0}
        error={recurring.state.error}
        busy={recurring.state.busy}
        onEditSchedule={backToSeries}
        onDone={backToSeries}
        role="receptionist"
      />
    );
  }
  return (
    <ReceptionistCancel
      preselectedAppointmentId={preselectedId}
      onBackToToday={onBackToToday}
    />
  );
}
