/**
 * DoctorApp — top-level doctor container (W59 deferral).
 *
 * Mirrors the receptionist and patient internal-router pattern.
 *
 * The doctor surface now carries the full set of sections from
 * `docs/design/user-flows/doctor.md` Act 1:
 *   - 'today'    → DoctorToday (mock 12) — the doctor's own day list
 *   - 'affected' → DoctorAffected (mock 06) — the E6-S2 affected queue
 *   - 'schedule' → DoctorSchedule (mock 09) — weekly working hours
 *   - 'blocks'   → DoctorBlocks (mock 10) — block time off
 *   - 'types'    → DoctorAppointmentTypes (mock 11) — the catalogue
 *   - 'series'   → RecurringSeriesForm (the recurring flow's entry step)
 *   - 'preview'  → RecurringPreviewPage (mock 07)
 *   - 'confirm'  → RecurringConfirmPage (mock 23)
 *   - 'backout'  → RecurringBackOut     (mock 40)
 *
 * The recurring flow is a real state machine over the API:
 * the series input is POSTed to `/recurring/preview`, the resulting
 * `preview_id` is POSTed to `/recurring/confirm`, and the response
 * is what the confirm screen renders. The pages themselves are
 * presentational — this component owns the request state.
 *
 * These are reachable via a `?page=…` query parameter so the screens
 * can be demoed without rewriting the existing affected-queue flow.
 * `today` is the default and is what the doctor sees on every
 * day-to-day login.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { DoctorAffected } from './DoctorAffected';
import { DoctorAppointmentTypes } from './DoctorAppointmentTypes';
import { DoctorAuditDrawer } from './DoctorAuditDrawer';
import { DoctorBlocks } from './DoctorBlocks';
import { DoctorSchedule } from './DoctorSchedule';
import { DoctorToday } from './DoctorToday';
import { RecurringSeriesForm } from './RecurringSeriesForm';
import { RecurringPreviewPage } from './RecurringPreviewPage';
import { RecurringConfirmPage } from './RecurringConfirmPage';
import { RecurringBackOut } from './RecurringBackOut';
import { useDeepLinkParam } from './deep-link';
import { useRecurringFlow } from './useRecurringFlow';

interface AuditTarget {
  appointmentId: string;
  appointmentLabel: string;
  branchTz: string;
}

type DoctorView =
  | 'today'
  | 'affected'
  | 'schedule'
  | 'blocks'
  | 'types'
  | 'series'
  | 'preview'
  | 'confirm'
  | 'backout';

interface DoctorAppProps {
  initialView?: DoctorView;
}

function toDoctorView(raw: string | null): DoctorView | null {
  // 'affected' is the doctor's default view. It was missing here, so
  // the URL and the view state could disagree: the nav link for
  // "Affected" set `#/doctor?page=affected`, which parsed to null
  // and fell back to the default state — the right screen by luck,
  // but the URL was never in sync with the view.
  if (
    raw === 'today' ||
    raw === 'affected' ||
    raw === 'schedule' ||
    raw === 'blocks' ||
    raw === 'types' ||
    raw === 'series' ||
    raw === 'preview' ||
    raw === 'confirm' ||
    raw === 'backout'
  ) {
    return raw;
  }
  return null;
}

/** Write the current view into the URL. */
function pushView(view: DoctorView): void {
  if (typeof window === 'undefined') return;
  const next = `#/doctor?page=${view}`;
  if (window.location.hash !== next) window.location.hash = next;
}

export function DoctorApp({ initialView }: DoctorAppProps) {
  const [view, setView] = useState<DoctorView>(initialView ?? 'today');
  const [auditTarget, setAuditTarget] = useState<AuditTarget | null>(null);

  // Honour a ?page=… deep-link so the new screens are reachable from
  // a URL paste.
  //
  // The deep link is read from the HASH fragment, not
  // `location.search` — the routes are hash-based
  // (`#/doctor?page=series`), so the query string lives inside the
  // fragment and `location.search` is always empty.
  //
  // This is a REACTIVE read: the app component stays mounted across a
  // hash-only navigation (no remount), so a mount-only effect never
  // re-ran and the view never changed.
  const pageParam = useDeepLinkParam('page');
  useEffect(() => {
    const v = toDoctorView(pageParam);
    if (v !== null) setView(v);
  }, [pageParam]);

  // Start each step of the recurring flow at the top of the page.
  //
  // The flow swaps the whole view (form → preview → confirm) inside
  // one mounted component, so the browser keeps the previous step's
  // scroll offset. After "Preview series →" the preview page opened
  // 331px down — the "Series details" heading and its first two rows
  // were already scrolled off the top, which is exactly the content
  // the doctor clicked to see.
  //
  // `useLayoutEffect` (not `useEffect`): it runs synchronously after
  // the DOM mutation and BEFORE the browser paints, so the new step
  // is never painted at the stale offset. A passive effect was
  // flushed late enough that the intermediate scroll position was
  // visible (and could be measured by a screenshot) first.
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [view]);

  const openAudit = useCallback((t: AuditTarget): void => {
    setAuditTarget(t);
  }, []);

  const closeAudit = useCallback((): void => {
    setAuditTarget(null);
  }, []);

  // The recurring flow is shared with the receptionist — see
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
    return <DoctorToday activeNav="today" />;
  }
  if (view === 'schedule') {
    return <DoctorSchedule activeNav="schedule" />;
  }
  if (view === 'blocks') {
    return <DoctorBlocks activeNav="blocks" />;
  }
  if (view === 'types') {
    return <DoctorAppointmentTypes activeNav="types" />;
  }
  if (view === 'series') {
    return (
      <RecurringSeriesForm
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
        role="doctor"
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
        onBackOut={() => {
          setView('backout');
          pushView('backout');
        }}
        role="doctor"
      />
    );
  }
  if (view === 'backout') {
    return <RecurringBackOut seriesId={recurring.state.result?.series_id} />;
  }
  return (
    <div data-testid="doctor-app">
      <DoctorAffected onOpenAudit={openAudit} />
      {auditTarget !== null && (
        <DoctorAuditDrawer
          appointmentId={auditTarget.appointmentId}
          appointmentLabel={auditTarget.appointmentLabel}
          branchTz={auditTarget.branchTz}
          onClose={closeAudit}
        />
      )}
    </div>
  );
}
