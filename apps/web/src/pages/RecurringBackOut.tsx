/**
 * RecurringBackOut — doctor back-out after partial creation (mock 40).
 *
 * Pixel-perfect port of mockup 40
 * (docs/design/mockups/v1/mockups/40-recurring-back-out.html).
 *
 * 760px stacked flow. Amber hero ("there is no undo"), list of
 * already-created occurrences, 4-card action grid (cancel
 * individual / leave / contact patient / reschedule hours), audit
 * log block, and a green principle note citing BR-052 / BRD §4.6 /
 * PRD §18.
 *
 * The series itself comes from `GET /doctor/recurring-series/:id` —
 * the doctor's own recurring series with every occurrence and the
 * audit trail. The per-occurrence cancel is the ordinary
 * `POST /appointments/:id/cancel` (a reason is mandatory per
 * FR-035), because the point of this screen is that there is no
 * bulk undo: the doctor acts one occurrence at a time.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  ApiError,
  doctorCancel,
  getDoctorRecurringSeries,
  type DoctorRecurringAuditRow,
  type DoctorRecurringSeries,
} from '../api/client';
import { DoctorFrame } from './DoctorFrame';
import { readDeepLinkParam } from './deep-link';
import styles from './RecurringBackOut.module.css';

interface RecurringBackOutProps {
  /** The series to back out of. When omitted the page reads
   *  `?series_id=` from the URL so the screen can be deep-linked. */
  seriesId?: string;
}

interface OccurrenceRow {
  id: string;
  start_datetime: string;
  end_datetime: string;
  status: string;
}

function dateParts(
  iso: string,
  tz: string,
): { month: string; day: string; dow: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  }).formatToParts(new Date(iso));
  const pick = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return {
    month: pick('month').toUpperCase(),
    day: pick('day'),
    dow: pick('weekday'),
  };
}

function timeIn(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${h}:${m}`;
}

function stamp(iso: string, tz: string): string {
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
  return date;
}

/** Read `?series_id=` from the URL — the deep-link entry point. */
function seriesIdFromUrl(): string {
  // Read from the HASH fragment, not `location.search` — the routes
  // are hash-based (`#/doctor?page=backout&series_id=…`).
  return readDeepLinkParam('series_id') ?? '';
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Session expired. Please sign in again.';
    if (err.status === 403) return 'This series belongs to another doctor.';
    if (err.status === 404) return 'That recurring series was not found.';
    return `Could not load the series (${err.code}).`;
  }
  if (err instanceof TypeError) {
    return 'Connection failed. Is the API running on :3001?';
  }
  return 'Could not load the series.';
}

function StepNum({
  n,
  state,
}: {
  n: number;
  state: 'done' | 'current' | 'todo';
}): ReactNode {
  const cls =
    state === 'done'
      ? `${styles['step-num']} ${styles['step-num-done']}`
      : state === 'current'
        ? `${styles['step-num']} ${styles['step-num-current']}`
        : styles['step-num'];
  return <div className={cls}>{n}</div>;
}

/** The audit event name, normalised to the series-creation events
 *  the screen talks about. */
function auditLabel(row: DoctorRecurringAuditRow): string {
  switch (row.event) {
    case 'recurring_created':
      return 'recurring_created';
    case 'recurring_skipped':
      return 'recurring_skipped';
    default:
      return row.event;
  }
}

export function RecurringBackOut({ seriesId }: RecurringBackOutProps): ReactNode {
  const [resolvedId, setResolvedId] = useState<string>(seriesId ?? '');
  const [series, setSeries] = useState<DoctorRecurringSeries | null>(null);
  const [audit, setAudit] = useState<DoctorRecurringAuditRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reason, setReason] = useState<string>('');
  const [pending, setPending] = useState<OccurrenceRow | null>(null);

  useEffect(() => {
    setResolvedId(seriesId ?? seriesIdFromUrl());
  }, [seriesId]);

  const load = useCallback((id: string): void => {
    if (id === '') {
      setLoading(false);
      setErr('No recurring series was selected.');
      return;
    }
    setLoading(true);
    getDoctorRecurringSeries(id)
      .then((res) => {
        setSeries(res.series);
        setAudit(res.audit);
        setErr(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setErr(describeError(e));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (resolvedId !== '') load(resolvedId);
  }, [resolvedId, load]);

  const tz = series?.tz ?? 'UTC';

  const scheduled = useMemo(
    () =>
      (series?.occurrences ?? []).filter(
        (o) => o.status === 'Scheduled',
      ) as OccurrenceRow[],
    [series],
  );

  /** Cancel one occurrence with a doctor-written reason (FR-035).
   *  A recurring occurrence is an ordinary appointment — there is
   *  no bulk undo by design (BR-052 / BRD §4.6). */
  const onCancel = useCallback((): void => {
    if (pending === null) return;
    const trimmed = reason.trim();
    if (trimmed === '') {
      setErr('A reason is required before cancelling (FR-035).');
      return;
    }
    setBusyId(pending.id);
    setErr(null);
    doctorCancel(pending.id, { reason: trimmed })
      .then(() => {
        setBusyId(null);
        setPending(null);
        setReason('');
        return getDoctorRecurringSeries(series?.series_id ?? '');
      })
      .then((res) => {
        setSeries(res.series);
        setAudit(res.audit);
      })
      .catch((e: unknown) => {
        setBusyId(null);
        setErr(describeError(e));
      });
  }, [pending, reason, series]);

  if (loading) {
    return (
      <DoctorFrame>
        <div className={styles['page']}>
          <header className={styles['page-header']}>
            <div className={styles.crumb}>Recurring &rarr; Back-out</div>
            <h1>Loading the series&hellip;</h1>
          </header>
        </div>
      </DoctorFrame>
    );
  }

  if (series === null) {
    return (
      <DoctorFrame>
        <div className={styles['page']}>
          <header className={styles['page-header']}>
            <div className={styles.crumb}>Recurring &rarr; Back-out</div>
            <h1>No recurring series to back out of.</h1>
            <p className={styles.sub}>
              {err ?? 'Create a recurring series to see it here.'}
            </p>
          </header>
        </div>
      </DoctorFrame>
    );
  }

  const total = series.occurrence_count;
  const skipped = Math.max(0, total - scheduled.length);

  return (
    <DoctorFrame>
      <div className={styles['page']}>
        <header className={styles['page-header']}>
          <div className={styles.crumb}>Recurring &rarr; Back-out</div>
          <h1>
            {total} appointment{total === 1 ? '' : 's'} already exist.
          </h1>
          <p className={styles.sub}>
            They were created at{' '}
            <strong style={{ color: 'var(--text-heading)' }}>
              {stamp(series.created_at, tz)}
            </strong>{' '}
            when the series was confirmed. The series is no longer pending.
          </p>
        </header>

        {err && <div className={styles['audit-row']}>{err}</div>}

        <div className={styles.hero}>
          <div className={styles['hero-icon']}>⏪</div>
          <div className={styles['hero-body']}>
            <h2>There is no undo for a recurring series.</h2>
            <p>
              You&rsquo;ve changed your mind, and that&rsquo;s fine — but the{' '}
              {total} appointments below already exist as{' '}
              <strong>independent appointments</strong> under{' '}
              <code>BR-052</code>. Each one has its own slot, its own patient, and
              its own audit row. Cancelling them here would be a{' '}
              <strong>silent invalidation</strong> (BRD §4.6 / PRD §18): the patient
              would receive a cancellation SMS with no explanation.
            </p>
          </div>
        </div>

        {/* Step 1 — What's on the books */}
        <div className={styles.step}>
          <div className={styles['step-head']}>
            <StepNum n={1} state="done" />
            <div className={styles['step-title']}>What&rsquo;s on the books</div>
            <div className={styles['step-hint']}>
              {series.scheduled_count} scheduled · {skipped} skipped ·{' '}
              {series.cancelled_count} cancelled
            </div>
          </div>
          <div className={styles.list}>
            <div className={styles['list-head']}>
              <div className={styles['list-head-title']}>
                Recurring series · {series.patient_phone} ·{' '}
                {series.appointment_type_name ?? 'Appointment'} ·{' '}
                {series.branch_name}
              </div>
              <div className={styles['list-head-count']}>
                {series.scheduled_count} of {total} live
              </div>
            </div>
            {series.occurrences.map((o) => {
              const parts = dateParts(o.start_datetime, tz);
              const isLive = o.status === 'Scheduled';
              return (
                <div
                  key={o.id}
                  className={
                    isLive ? styles['occ-row'] : `${styles['occ-row']} ${styles['occ-row-skip']}`
                  }
                >
                  <div className={styles['occ-date']}>
                    <div className={styles['occ-date-month']}>{parts.month}</div>
                    <div className={styles['occ-date-day']}>{parts.day}</div>
                    <div className={styles['occ-date-dow']}>{parts.dow}</div>
                  </div>
                  <div className={styles['occ-body']}>
                    <div
                      className={
                        isLive
                          ? styles['occ-body-title']
                          : `${styles['occ-body-title']} ${styles['occ-body-title-strike']}`
                      }
                    >
                      {timeIn(o.start_datetime, tz)} –{' '}
                      {timeIn(o.end_datetime, tz)} · {series.branch_name}
                    </div>
                    <div className={styles['occ-body-meta']}>
                      Appt #{o.id.slice(0, 8)} · {series.patient_phone} ·{' '}
                      {o.status}
                    </div>
                  </div>
                  {isLive ? (
                    <button
                      type="button"
                      className={styles['btn-secondary']}
                      disabled={busyId !== null}
                      onClick={() => {
                        setPending(o);
                        setErr(null);
                      }}
                    >
                      Cancel
                    </button>
                  ) : (
                    <span className={styles['occ-skip']}>{o.status}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Per-occurrence cancel — the one write this screen performs */}
        {pending !== null && (
          <div className={styles.step}>
            <div className={styles['step-head']}>
              <StepNum n={2} state="current" />
              <div className={styles['step-title']}>
                Cancel one occurrence
              </div>
              <div className={styles['step-hint']}>
                A reason is required (FR-035)
              </div>
            </div>
            <div className={styles['action-card']}>
              <div className={styles['action-card-head']}>
                {dateParts(pending.start_datetime, tz).dow}{' '}
                {dateParts(pending.start_datetime, tz).day}{' '}
                {dateParts(pending.start_datetime, tz).month} ·{' '}
                {timeIn(pending.start_datetime, tz)}–
                {timeIn(pending.end_datetime, tz)}
              </div>
              <div className={styles['action-card-body']}>
                <textarea
                  value={reason}
                  maxLength={500}
                  rows={3}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason shown to the patient on the cancellation notice"
                  style={{
                    width: '100%',
                    marginTop: 'var(--space-3)',
                    padding: '10px 12px',
                    border: '1.5px solid var(--border-default)',
                    borderRadius: 'var(--radius-sm)',
                    fontFamily: 'inherit',
                    fontSize: 'var(--text-sm)',
                    background: 'var(--surface-card)',
                    color: 'var(--text-heading)',
                  }}
                />
              </div>
            </div>
            <div className={styles['step-foot']}>
              <button
                type="button"
                className={styles['btn-ghost']}
                onClick={() => {
                  setPending(null);
                  setReason('');
                }}
              >
                Keep it
              </button>
              <button
                type="button"
                className={styles['btn-primary']}
                disabled={busyId !== null || reason.trim() === ''}
                onClick={onCancel}
              >
                {busyId !== null ? 'Cancelling…' : 'Cancel this occurrence'}
              </button>
            </div>
          </div>
        )}

        {/* Step 2 — Choose your next move */}
        <div className={styles.step}>
          <div className={styles['step-head']}>
            <StepNum n={2} state="current" />
            <div className={styles['step-title']}>Choose your next move</div>
            <div className={styles['step-hint']}>You decide, not the system</div>
          </div>
          <div className={styles['action-grid']}>
            <div className={styles['action-card']}>
              <div className={styles['action-card-ic']}>1</div>
              <div className={styles['action-card-head']}>
                Cancel individual occurrences
              </div>
              <div className={styles['action-card-body']}>
                Cancel each appointment you no longer want — each one sends the
                patient a cancellation reason that you write. Audit row per
                cancellation.
              </div>
            </div>
            <div className={styles['action-card']}>
              <div className={styles['action-card-ic']}>2</div>
              <div className={styles['action-card-head']}>
                Leave them on the schedule
              </div>
              <div className={styles['action-card-body']}>
                Keep all {series.scheduled_count} as booked. The patient remains
                committed. If the plan changes later, you can cancel one at a time.
              </div>
            </div>
            <div className={styles['action-card']}>
              <div className={styles['action-card-ic']}>3</div>
              <div className={styles['action-card-head']}>
                Contact the patient first
              </div>
              <div className={styles['action-card-body']}>
                Phone or message {series.patient_phone} to discuss the change before
                deciding what to cancel.
              </div>
            </div>
            <div className={styles['action-card']}>
              <div className={styles['action-card-ic']}>4</div>
              <div className={styles['action-card-head']}>
                Reschedule the doctor&rsquo;s hours instead
              </div>
              <div className={styles['action-card-body']}>
                If the issue is that the slot is now inconvenient, move the slot.
                Existing appointments stay — only the time block changes, and
                patients are notified.
              </div>
            </div>
          </div>
        </div>

        {/* Audit log block */}
        <div className={styles['audit-block']}>
          <div className={styles['audit-head']}>
            <span className={styles['audit-head-label']}>
              Audit log · for this series
            </span>
          </div>
          {audit.length === 0 ? (
            <div className={`${styles['audit-row']} ${styles['audit-row-quiet']}`}>
              No audit rows yet — your next action will write its own row.
            </div>
          ) : (
            audit.map((a) => (
              <div key={a.id} className={styles['audit-row']}>
                <span className={styles['audit-row-actor']}>{a.actor_id}</span> ·{' '}
                {auditLabel(a)} · {stamp(a.created_at, tz)}
              </div>
            ))
          )}
        </div>

        <div className={styles['principle-note']}>
          <span className={styles.ic}>🛡</span>
          <div>
            <strong>Why no &ldquo;undo&rdquo;?</strong> Because &ldquo;undo&rdquo; would
            mean cancelling {total} appointments the patient already committed to.
            The system doesn&rsquo;t decide that for you — you do, one at a time, with
            an audit trail and a reason you write. That&rsquo;s <code>BR-052</code>{' '}
            (per-occurrence independence), <code>BRD §4.6</code> (never silently
            invalidate), and <code>PRD §18</code> (audit every change). Three rules,
            one principle: <strong>act, don&rsquo;t un-act</strong>.
          </div>
        </div>
      </div>
    </DoctorFrame>
  );
}
