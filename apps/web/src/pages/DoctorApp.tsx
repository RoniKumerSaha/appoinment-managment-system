/**
 * DoctorApp — top-level doctor container (W59 deferral).
 *
 * Mirrors the receptionist and patient internal-router pattern.
 * Today the doctor surface exposes the E6-S2 affected queue +
 * resolve flow, plus the E7-S2 audit drawer (mock 30). The view
 * machine also surfaces the recurring screens:
 *   - 'series'   → RecurringSeriesForm (the flow's entry step)
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
 * These are reachable via a `?page=series|preview|confirm|backout`
 * query parameter so the screens can be demoed without rewriting
 * the existing affected-queue flow. The `affected` view remains
 * the default and is what the doctor sees on every day-to-day
 * login.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { DoctorAffected } from './DoctorAffected';
import { DoctorAuditDrawer } from './DoctorAuditDrawer';
import { RecurringSeriesForm } from './RecurringSeriesForm';
import { RecurringPreviewPage } from './RecurringPreviewPage';
import { RecurringConfirmPage } from './RecurringConfirmPage';
import { RecurringBackOut } from './RecurringBackOut';
import { useDeepLinkParam } from './deep-link';
import {
  confirmRecurringSeries,
  listStaffAppointmentTypes,
  listStaffBranches,
  listStaffDoctors,
  previewRecurringSeries,
  type RecurringConfirmResponse,
  type RecurringPreviewResponse,
  type RecurringSeriesInput,
} from '../api/client';

interface AuditTarget {
  appointmentId: string;
  appointmentLabel: string;
  branchTz: string;
}

type DoctorView = 'affected' | 'series' | 'preview' | 'confirm' | 'backout';

interface DoctorAppProps {
  initialView?: DoctorView;
}

/** The recurring flow's own state, kept together so the preview
 *  screen can be reached from the form and the confirm screen from
 *  the preview without losing what was already fetched. */
interface RecurringState {
  input: RecurringSeriesInput | null;
  preview: RecurringPreviewResponse | null;
  result: RecurringConfirmResponse | null;
  error: string | null;
  busy: boolean;
}

const EMPTY_RECURRING: RecurringState = {
  input: null,
  preview: null,
  result: null,
  error: null,
  busy: false,
};

/** Id → display name, resolved once from the staff catalogue. */
interface Catalogue {
  doctors: Map<string, string>;
  branches: Map<string, string>;
  types: Map<string, string>;
}

const EMPTY_CATALOGUE: Catalogue = {
  doctors: new Map(),
  branches: new Map(),
  types: new Map(),
};

function toDoctorView(raw: string | null): DoctorView | null {
  // 'affected' is the doctor's default view. It was missing here, so
  // the URL and the view state could disagree: the nav link for
  // "Affected" set `#/doctor?page=affected`, which parsed to null
  // and fell back to the default state — the right screen by luck,
  // but the URL was never in sync with the view.
  if (
    raw === 'affected' ||
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
  const [view, setView] = useState<DoctorView>(initialView ?? 'affected');
  const [auditTarget, setAuditTarget] = useState<AuditTarget | null>(null);
  const [recurring, setRecurring] = useState<RecurringState>(EMPTY_RECURRING);
  const [catalogue, setCatalogue] = useState<Catalogue>(EMPTY_CATALOGUE);

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

  // Resolve the ids the recurring flow submits into display names.
  //
  // `POST /recurring/preview` answers with ids only (`branch.id`,
  // and the doctor/type ids are only in the request we sent), so the
  // preview and confirm screens used to render raw UUIDs in their
  // "Series details" tiles — a 36-character id where "Dr. East
  // Lead" belongs. The staff catalogue is open to every
  // authenticated caller, so the doctor can resolve the names
  // client-side without a new API route.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [doctors, branches, types] = await Promise.all([
          listStaffDoctors({ active: true }),
          listStaffBranches('active'),
          listStaffAppointmentTypes({ active: true }),
        ]);
        if (cancelled) return;
        setCatalogue({
          doctors: new Map(doctors.map((d) => [d.id, d.full_name])),
          branches: new Map(branches.map((b) => [b.id, b.name])),
          types: new Map(types.map((t) => [t.id, t.name])),
        });
      } catch {
        // A catalogue failure is non-fatal — the labels fall back to
        // a shortened id so the screen still reads.
        if (!cancelled) setCatalogue(EMPTY_CATALOGUE);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openAudit = useCallback((t: AuditTarget): void => {
    setAuditTarget(t);
  }, []);

  const closeAudit = useCallback((): void => {
    setAuditTarget(null);
  }, []);

  const runPreview = useCallback((input: RecurringSeriesInput): void => {
    setRecurring({ ...EMPTY_RECURRING, input, busy: true });
    void (async () => {
      try {
        const preview = await previewRecurringSeries(input);
        setRecurring({ input, preview, result: null, error: null, busy: false });
        setView('preview');
        pushView('preview');
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'preview_failed';
        setRecurring({ input, preview: null, result: null, error: message, busy: false });
      }
    })();
  }, []);

  const runConfirm = useCallback((): void => {
    const preview = recurring.preview;
    if (preview === null) return;
    setRecurring((prev) => ({ ...prev, busy: true, error: null }));
    void (async () => {
      try {
        const result = await confirmRecurringSeries(preview.preview_id);
        setRecurring((prev) => ({ ...prev, result, busy: false }));
        setView('confirm');
        pushView('confirm');
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'confirm_failed';
        setRecurring((prev) => ({ ...prev, busy: false, error: message }));
      }
    })();
  }, [recurring.preview]);

  const backToSeries = useCallback((): void => {
    setRecurring(EMPTY_RECURRING);
    setView('series');
    pushView('series');
  }, []);

  if (view === 'series') {
    return (
      <RecurringSeriesForm
        error={recurring.error}
        busy={recurring.busy}
        onSubmit={runPreview}
      />
    );
  }
  if (view === 'preview' && recurring.preview !== null) {
    return (
      <RecurringPreviewPage
        preview={recurring.preview}
        labels={recurringLabels(recurring, catalogue)}
        requested={recurring.input?.occurrences_or_until_date ?? 0}
        error={recurring.error}
        busy={recurring.busy}
        onCancel={backToSeries}
        onEditPattern={backToSeries}
        onConfirm={runConfirm}
      />
    );
  }
  if (view === 'confirm' && recurring.result !== null) {
    return (
      <RecurringConfirmPage
        result={recurring.result}
        labels={recurringLabels(recurring, catalogue)}
        requested={recurring.input?.occurrences_or_until_date ?? 0}
        error={recurring.error}
        busy={recurring.busy}
        onEditSchedule={backToSeries}
        onDone={backToSeries}
        onBackOut={() => {
          setView('backout');
          pushView('backout');
        }}
      />
    );
  }
  if (view === 'backout') {
    return <RecurringBackOut seriesId={recurring.result?.series_id} />;
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

/** The preview/confirm screens label the series in prose.
 *
 *  The ids are resolved against the staff catalogue so the tiles read
 *  "Dr. East Lead" / "East Branch" / "General Consultation". When the
 *  catalogue lookup has not landed (or failed), the id is shortened to
 *  its last 4 characters — a full UUID in a 160px tile is noise, and
 *  a 4-character tail is still correlatable with the detail view. */
function recurringLabels(
  state: RecurringState,
  catalogue: Catalogue,
): {
  patient: string;
  doctor: string;
  branch: string;
  type: string;
  pattern: string;
} {
  const preview = state.preview;
  const kind = preview?.recurrence.kind ?? state.input?.recurrence_kind;
  const pattern =
    kind === 'every_two_weeks'
      ? 'every 2 weeks'
      : kind === 'custom_days'
        ? `every ${preview?.recurrence.interval_days ?? state.input?.recurrence_interval_days ?? 1} days`
        : 'weekly';
  const doctorId = state.input?.doctor_id;
  const branchId = preview?.branch.id ?? state.input?.branch_id;
  const typeId = state.input?.appointment_type_id;
  return {
    patient: state.input?.patient_first_name ?? state.input?.patient_phone ?? '—',
    doctor:
      (doctorId === undefined ? undefined : catalogue.doctors.get(doctorId)) ??
      shortId(doctorId),
    branch:
      (branchId === undefined ? undefined : catalogue.branches.get(branchId)) ??
      shortId(branchId),
    type:
      (typeId === undefined ? undefined : catalogue.types.get(typeId)) ??
      shortId(typeId),
    pattern,
  };
}

/** `993febc2-4a62-423c-90e8-a7ed1b27e6b4` → `·1b27`. */
function shortId(id: string | undefined): string {
  if (id === undefined || id === '') return '—';
  return `·${id.slice(-4)}`;
}
