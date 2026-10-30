/**
 * useRecurringFlow — the shared state machine behind the recurring
 * series entry step (form → preview → confirm).
 *
 * The doctor and the receptionist both book recurring series, and
 * they run the SAME three API calls:
 *
 *   1. `POST /recurring/preview` with the series shape → a
 *      `preview_id` plus the per-occurrence create/skip breakdown.
 *   2. `POST /recurring/confirm` with the `preview_id` → the rows
 *      that were actually created (the confirm route re-validates).
 *
 * The two surfaces differ in exactly one thing on the wire — which
 * `doctor_id` is legal:
 *
 *   - A DOCTOR books for themselves. The preview route binds
 *     `doctor_id` to `claim.doctor_id` and rejects anything else with
 *     403 `outside_branch_scope`, so the doctor's form shows a fixed
 *     read-only doctor.
 *   - A RECEPTIONIST books on behalf of a patient for any doctor at
 *     their branch. The scope is branch-only (BR-004), and the route
 *     re-checks the pairing server-side (`doctor_not_at_branch`).
 *
 * Everything else — the lookups, the duration/type coupling, the
 * same-day exclusion (FR-019), the request body — is identical. So
 * the state machine lives here and BOTH apps drive it. If the two
 * copies were maintained separately they would drift, and a drift
 * here is a booking bug, not a cosmetic one.
 *
 * The frames stay with the callers: the hook owns the DATA, the app
 * owns the CHROME.
 */
import { useCallback, useEffect, useState } from 'react';
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

/** The recurring flow's own state, kept together so the preview
 *  screen can be reached from the form and the confirm screen from
 *  the preview without losing what was already fetched. */
export interface RecurringState {
  input: RecurringSeriesInput | null;
  preview: RecurringPreviewResponse | null;
  result: RecurringConfirmResponse | null;
  error: string | null;
  busy: boolean;
}

export const EMPTY_RECURRING: RecurringState = {
  input: null,
  preview: null,
  result: null,
  error: null,
  busy: false,
};

/** Id → display name, resolved once from the staff catalogue. */
export interface RecurringCatalogue {
  doctors: Map<string, string>;
  branches: Map<string, string>;
  types: Map<string, string>;
}

export const EMPTY_CATALOGUE: RecurringCatalogue = {
  doctors: new Map(),
  branches: new Map(),
  types: new Map(),
};

/** The labels the preview / confirm screens render the series in. */
export interface RecurringLabels {
  patient: string;
  doctor: string;
  branch: string;
  type: string;
  pattern: string;
}

export interface UseRecurringFlow {
  state: RecurringState;
  labels: RecurringLabels;
  /** POST the series shape to `/recurring/preview`. */
  runPreview: (input: RecurringSeriesInput) => void;
  /** POST the held `preview_id` to `/recurring/confirm`. */
  runConfirm: () => void;
  /** Drop everything and start the flow again from the form. */
  reset: () => void;
}

/**
 * Drive the recurring flow.
 *
 * `onPreview` / `onConfirm` are called after the corresponding request
 * resolves, so the caller can move its own view state (and the URL)
 * at the right moment. They are NOT called on failure — a failed
 * request leaves the error on the form/preview screen where the user
 * can see it and retry.
 */
export function useRecurringFlow(options?: {
  onPreview?: () => void;
  onConfirm?: () => void;
}): UseRecurringFlow {
  const [state, setState] = useState<RecurringState>(EMPTY_RECURRING);
  const [catalogue, setCatalogue] = useState<RecurringCatalogue>(
    EMPTY_CATALOGUE,
  );

  // Resolve the ids the recurring flow submits into display names.
  //
  // `POST /recurring/preview` answers with ids only (`branch.id`, and
  // the doctor/type ids are only in the request we sent), so the
  // preview and confirm screens used to render raw UUIDs in their
  // "Series details" tiles — a 36-character id where "Dr. East
  // Lead" belongs. The staff catalogue is open to every
  // authenticated caller, so the names can be resolved client-side
  // without a new API route.
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

  const onPreview = options?.onPreview;
  const onConfirm = options?.onConfirm;

  const runPreview = useCallback(
    (input: RecurringSeriesInput): void => {
      setState({ ...EMPTY_RECURRING, input, busy: true });
      void (async () => {
        try {
          const preview = await previewRecurringSeries(input);
          setState({ input, preview, result: null, error: null, busy: false });
          onPreview?.();
        } catch (err) {
          const message =
            err instanceof Error ? err.message : 'preview_failed';
          setState({
            input,
            preview: null,
            result: null,
            error: message,
            busy: false,
          });
        }
      })();
    },
    [onPreview],
  );

  const runConfirm = useCallback((): void => {
    const preview = state.preview;
    if (preview === null) return;
    setState((prev) => ({ ...prev, busy: true, error: null }));
    void (async () => {
      try {
        const result = await confirmRecurringSeries(preview.preview_id);
        setState((prev) => ({ ...prev, result, busy: false }));
        onConfirm?.();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'confirm_failed';
        setState((prev) => ({ ...prev, busy: false, error: message }));
      }
    })();
  }, [state.preview, onConfirm]);

  const reset = useCallback((): void => {
    setState(EMPTY_RECURRING);
  }, []);

  const labels = buildLabels(state, catalogue);

  return { state, labels, runPreview, runConfirm, reset };
}

/** The preview/confirm screens label the series in prose.
 *
 *  The ids are resolved against the staff catalogue so the tiles read
 *  "Dr. East Lead" / "East Branch" / "General Consultation". When the
 *  catalogue lookup has not landed (or failed), the id is shortened to
 *  its last 4 characters — a full UUID in a 160px tile is noise, and
 *  a 4-character tail is still correlatable with the detail view. */
function buildLabels(
  state: RecurringState,
  catalogue: RecurringCatalogue,
): RecurringLabels {
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
