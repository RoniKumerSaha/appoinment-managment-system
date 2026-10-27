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
import { useCallback, useEffect, useState } from 'react';
import { DoctorAffected } from './DoctorAffected';
import { DoctorAuditDrawer } from './DoctorAuditDrawer';
import { RecurringSeriesForm } from './RecurringSeriesForm';
import { RecurringPreviewPage } from './RecurringPreviewPage';
import { RecurringConfirmPage } from './RecurringConfirmPage';
import { RecurringBackOut } from './RecurringBackOut';
import {
  confirmRecurringSeries,
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

function readPageParam(): DoctorView | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('page');
  if (
    raw === 'series' ||
    raw === 'preview' ||
    raw === 'confirm' ||
    raw === 'backout'
  ) {
    return raw;
  }
  return null;
}

export function DoctorApp({ initialView }: DoctorAppProps) {
  const [view, setView] = useState<DoctorView>(initialView ?? 'affected');
  const [auditTarget, setAuditTarget] = useState<AuditTarget | null>(null);
  const [recurring, setRecurring] = useState<RecurringState>(EMPTY_RECURRING);

  // Honour a one-shot ?page=… deep-link so the new screens are
  // reachable from a URL paste.
  useEffect(() => {
    const v = readPageParam();
    if (v !== null) setView(v);
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
        labels={recurringLabels(recurring)}
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
        labels={recurringLabels(recurring)}
        requested={recurring.input?.occurrences_or_until_date ?? 0}
        error={recurring.error}
        busy={recurring.busy}
        onEditSchedule={backToSeries}
        onDone={backToSeries}
        onBackOut={() => setView('backout')}
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

/** The preview/confirm screens label the series in prose. The labels
 *  are derived from the ids the form submitted, so a name lookup is
 *  not needed for the flow to read correctly — the id is shown
 *  alongside the human-readable bits the server gave us. */
function recurringLabels(state: RecurringState): {
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
  return {
    patient: state.input?.patient_first_name ?? state.input?.patient_phone ?? '—',
    doctor: state.input?.doctor_id ?? '—',
    branch: preview?.branch.id ?? state.input?.branch_id ?? '—',
    type: state.input?.appointment_type_id ?? '—',
    pattern,
  };
}
