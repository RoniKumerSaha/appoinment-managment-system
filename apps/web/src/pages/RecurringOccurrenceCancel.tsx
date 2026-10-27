/**
 * RecurringOccurrenceCancel — patient per-occurrence cancel (mock 33).
 *
 * Pixel-perfect port of mockup 33
 * (docs/design/mockups/v1/mockups/33-recurring-occurrence-cancel.html).
 *
 * Series context card (E6-S4 key affordance) sits at top, then a
 * target-occurrence section, a sibling list (past / target /
 * upcoming), an alt-card "Cancel the whole series →" link, and
 * section actions footer. The confirmation modal (per FR-049)
 * sits on top of the page.
 *
 * The data comes from `GET /patient/recurring-series` — the patient
 * needs the WHOLE series in view to see that cancelling one visit
 * leaves the siblings alone (BR-052 / FR-049). The cancel itself is
 * the ordinary `POST /patient/appointments/:id/cancel`; a recurring
 * occurrence is an ordinary appointment with a series id on it.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ApiError,
  getPatientRecurringSeries,
  patientCancel,
  type PatientRecurringSeries,
  type RecurringSeriesOccurrence,
} from '../api/client';
import { PatientFrame } from './PatientFrame';
import { useAuth } from '../auth/store';
import styles from './RecurringOccurrenceCancel.module.css';

type OccurrenceState = 'completed' | 'target' | 'scheduled';

interface Sibling {
  ix: number;
  occurrence: RecurringSeriesOccurrence;
  state: OccurrenceState;
}

/** The status of an occurrence that has already happened. A past
 *  Scheduled row still reads as "completed" from the patient's
 *  point of view — the clinic has not marked it, but the visit
 *  happened. */
function isPast(iso: string): boolean {
  return new Date(iso).getTime() < Date.now();
}

function stateOf(
  occurrence: RecurringSeriesOccurrence,
  isTarget: boolean,
): OccurrenceState {
  if (isTarget) return 'target';
  if (occurrence.status !== 'Scheduled') return 'completed';
  return isPast(occurrence.start_datetime) ? 'completed' : 'scheduled';
}

function dateParts(iso: string): { month: string; day: string; dow: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  }).formatToParts(new Date(iso));
  const pick = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return {
    month: pick('month'),
    day: pick('day'),
    dow: pick('weekday'),
  };
}

function shortDate(iso: string): string {
  const d = dateParts(iso);
  return `${d.dow} ${d.day} ${d.month}`;
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

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Session expired. Please sign in again.';
    if (err.status === 403) return 'You do not have access to this list.';
    if (err.status === 404) return 'That occurrence is no longer available.';
    return `Could not load the series (${err.code}).`;
  }
  if (err instanceof TypeError) {
    return 'Connection failed. Is the API running on :3001?';
  }
  return 'Could not load the series.';
}

export function RecurringOccurrenceCancel(): ReactNode {
  const { stored } = useAuth();
  const userName = stored?.profile?.full_name ?? undefined;
  const [seriesList, setSeriesList] = useState<PatientRecurringSeries[]>([]);
  const [seriesId, setSeriesId] = useState<string>('');
  const [targetId, setTargetId] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [busy, setBusy] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState<boolean>(false);
  const [cancelled, setCancelled] = useState<boolean>(false);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    getPatientRecurringSeries()
      .then((res) => {
        if (stale) return;
        setSeriesList(res.series);
        // Default to the first series whose next occurrence is still
        // cancellable — a series whose every occurrence is done has
        // nothing to cancel.
        const firstLive = res.series.find((s) =>
          s.occurrences.some(
            (o) => o.status === 'Scheduled' && !isPast(o.start_datetime),
          ),
        );
        const chosen = firstLive ?? res.series[0];
        if (chosen !== undefined) {
          setSeriesId(chosen.series_id);
          const live = chosen.occurrences.find(
            (o) => o.status === 'Scheduled' && !isPast(o.start_datetime),
          );
          setTargetId((live ?? chosen.occurrences[0])?.id ?? '');
        }
        setErr(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (stale) return;
        setErr(describeError(e));
        setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, []);

  const series = useMemo(
    () => seriesList.find((s) => s.series_id === seriesId) ?? null,
    [seriesList, seriesId],
  );

  const siblings = useMemo<Sibling[]>(() => {
    if (series === null) return [];
    return series.occurrences.map((occurrence, i) => ({
      ix: i + 1,
      occurrence,
      state: stateOf(occurrence, occurrence.id === targetId),
    }));
  }, [series, targetId]);

  const target = useMemo(
    () => siblings.find((s) => s.state === 'target') ?? null,
    [siblings],
  );
  const past = siblings.filter((s) => s.state === 'completed');
  const upcoming = siblings.filter((s) => s.state !== 'completed');
  const scheduledCount = siblings.filter(
    (s) => s.occurrence.status === 'Scheduled' && s.state !== 'target',
  ).length;

  const onCancel = useCallback((): void => {
    if (target === null) return;
    setBusy(true);
    setErr(null);
    patientCancel(target.occurrence.id)
      .then(() => {
        setBusy(false);
        setConfirmOpen(false);
        setCancelled(true);
        // Refresh so the sibling list shows the new terminal state.
        return getPatientRecurringSeries();
      })
      .then((res) => {
        setSeriesList(res.series);
      })
      .catch((e: unknown) => {
        setBusy(false);
        setErr(describeError(e));
      });
  }, [target]);

  if (loading) {
    return (
      <PatientFrame userName={userName}>
        <div className={styles['page']}>
          <header className={styles['page-header']}>
            <h1>Cancel one occurrence</h1>
            <div className={styles.sub}>Loading your series…</div>
          </header>
        </div>
      </PatientFrame>
    );
  }

  if (seriesList.length === 0) {
    return (
      <PatientFrame userName={userName}>
        <div className={styles['page']}>
          <header className={styles['page-header']}>
            <h1>Cancel one occurrence</h1>
            <div className={styles.sub}>
              You have no recurring series to cancel.
            </div>
          </header>
        </div>
      </PatientFrame>
    );
  }

  if (series === null || target === null) {
    return (
      <PatientFrame userName={userName}>
        <div className={styles['page']}>
          <header className={styles['page-header']}>
            <h1>Cancel one occurrence</h1>
            <div className={styles.sub}>
              There is no cancellable occurrence in this series.
            </div>
          </header>
        </div>
      </PatientFrame>
    );
  }

  const tz = series.tz;
  const targetParts = dateParts(target.occurrence.start_datetime);
  const targetTime = `${timeIn(target.occurrence.start_datetime, tz)}–${timeIn(target.occurrence.end_datetime, tz)}`;

  return (
    <PatientFrame userName={userName}>
      <div className={styles['page']}>
        {/* Crumb */}
        <nav className={styles.crumb}>
          <a>My appointments</a>
          <span className={styles['crumb-sep']}>&rsaquo;</span>
          <span className={styles['crumb-here']}>Cancel one occurrence</span>
        </nav>

        {/* Page header */}
        <header className={styles['page-header']}>
          <h1>Cancel one occurrence</h1>
          <div className={styles.sub}>
            You&rsquo;re cancelling a single visit from a recurring series. Other visits in
            the series will not be affected.
          </div>
        </header>

        {err && <div className={styles['modal-lead']}>⚠ {err}</div>}

        {seriesList.length > 1 && (
          <div className={styles['form-group']}>
            <label htmlFor="recur-series-pick">Series</label>
            <select
              id="recur-series-pick"
              value={seriesId}
              onChange={(e) => {
                setSeriesId(e.target.value);
                const next = seriesList.find(
                  (s) => s.series_id === e.target.value,
                );
                const live = next?.occurrences.find(
                  (o) => o.status === 'Scheduled' && !isPast(o.start_datetime),
                );
                setTargetId((live ?? next?.occurrences[0])?.id ?? '');
              }}
            >
              {seriesList.map((s) => (
                <option key={s.series_id} value={s.series_id}>
                  {s.doctor_name} · {s.appointment_type_name ?? 'Consultation'} (
                  {s.occurrence_count} occurrence
                  {s.occurrence_count === 1 ? '' : 's'})
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Series context card (E6-S4 key affordance) */}
        <div className={styles['series-card']}>
          <div className={styles['series-icon']}>&rarr;</div>
          <div className={styles['series-body']}>
            <div className={styles['series-label']}>Recurring series</div>
            <div className={styles['series-title']}>
              {series.doctor_name}
            </div>
            <div className={styles['series-meta']}>
              {series.branch_name}
              {series.appointment_type_name !== null &&
                ` · ${series.appointment_type_name}`}
              {series.duration_minutes !== null &&
                ` (${series.duration_minutes} min)`}
              {` · Started ${shortDate(series.series_start)}`}
            </div>
          </div>
          <div className={styles['series-counter']}>
            Occurrence{' '}
            <span className={styles['series-counter-num']}>
              {target.ix}
            </span>{' '}
            of {series.occurrence_count}
          </div>
        </div>

        {/* Target occurrence section */}
        <section className={styles.section}>
          <header className={styles['section-head']}>
            <div className={styles['section-title']}>
              This occurrence will be cancelled
            </div>
            <div className={styles['section-sub']}>Slot will be released.</div>
          </header>
          <div className={styles['section-body']}>
            <div className={styles['target-card']}>
              <div className={styles['target-card-radio']} aria-label="selected" />
              <div className={styles['target-date-block']}>
                <div className={styles['target-date-month']}>
                  {targetParts.month}
                </div>
                <div className={styles['target-date-day']}>
                  {targetParts.day}
                </div>
                <div className={styles['target-date-dow']}>
                  {targetParts.dow}
                </div>
              </div>
              <div className={styles['target-body']}>
                <div className={styles['target-row1']}>
                  {series.doctor_name} · {series.branch_name}
                </div>
                <div className={styles['target-row2']}>
                  {shortDate(target.occurrence.start_datetime)} · {targetTime}
                </div>
              </div>
              <div className={styles['target-pill']}>This one</div>
            </div>
          </div>
        </section>

        {/* Sibling list (other occurrences — left alone) */}
        <section className={styles.section}>
          <header className={styles['section-head']}>
            <div className={styles['section-title']}>
              Other occurrences in this series
            </div>
            <div className={styles['section-sub']}>
              {scheduledCount} still scheduled · unaffected
            </div>
          </header>
          <div className={styles['section-body']}>
            {past.length > 0 && (
              <>
                <div className={styles['sibling-list']}>
                  {past.map((s) => (
                    <div
                      key={s.ix}
                      className={`${styles.sibling} ${styles['sibling-past']}`}
                    >
                      <div className={styles['sibling-ix']}>{s.ix}</div>
                      <div className={styles['sibling-date']}>
                        {shortDate(s.occurrence.start_datetime)}
                      </div>
                      <div className={styles['sibling-time']}>
                        {timeIn(s.occurrence.start_datetime, tz)}
                      </div>
                      <div
                        className={`${styles['sibling-status']} ${styles['sibling-status-completed']}`}
                      >
                        {s.occurrence.status === 'Scheduled'
                          ? 'Completed'
                          : s.occurrence.status}
                      </div>
                    </div>
                  ))}
                </div>
                <div className={styles['sibling-divider']}>— upcoming —</div>
              </>
            )}

            <div className={styles['sibling-list']}>
              {upcoming.map((s) => {
                if (s.state === 'target') {
                  return (
                    <div
                      key={s.ix}
                      className={`${styles.sibling} ${styles['sibling-target']}`}
                    >
                      <div className={styles['sibling-ix']}>{s.ix}</div>
                      <div className={styles['sibling-date']}>
                        {shortDate(s.occurrence.start_datetime)}
                      </div>
                      <div className={styles['sibling-time']}>
                        {timeIn(s.occurrence.start_datetime, tz)}
                      </div>
                      <div
                        className={`${styles['sibling-status']} ${styles['sibling-status-target']}`}
                      >
                        {cancelled ? 'Cancelled' : 'Cancelling…'}
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={s.ix} className={styles.sibling}>
                    <div className={styles['sibling-ix']}>{s.ix}</div>
                    <div className={styles['sibling-date']}>
                      {shortDate(s.occurrence.start_datetime)}
                    </div>
                    <div className={styles['sibling-time']}>
                      {timeIn(s.occurrence.start_datetime, tz)}
                    </div>
                    <div
                      className={`${styles['sibling-status']} ${styles['sibling-status-scheduled']}`}
                    >
                      {s.occurrence.status}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Footnote: explain independence */}
            <div className={styles['sibling-foot']}>
              <span className={styles.ic}>i</span>
              <div>
                <strong>Each occurrence is independent</strong> after creation (per
                BR-052 / FR-049). Cancelling this one only releases{' '}
                {shortDate(target.occurrence.start_datetime)} ·{' '}
                {timeIn(target.occurrence.start_datetime, tz)}. The other{' '}
                {scheduledCount} upcoming visit
                {scheduledCount === 1 ? '' : 's'} stay Scheduled and can be cancelled or
                rescheduled individually.
              </div>
            </div>

            {/* Alt: cancel the whole series */}
            <div className={styles['alt-card']}>
              <div className={styles['alt-icon']}>&rarr;</div>
              <div className={styles['alt-body']}>
                <div className={styles['alt-t']}>
                  Want to stop the whole series?
                </div>
                <div className={styles['alt-s']}>
                  You can also cancel every upcoming occurrence at once.
                </div>
              </div>
              <span className={styles['alt-link']}>Cancel series &rarr;</span>
            </div>
          </div>
        </section>

        {/* Footer actions */}
        <section className={styles.section}>
          <div className={styles['section-actions']}>
            <button
              type="button"
              className={styles['btn-ghost']}
              onClick={() => window.history.back()}
            >
              Back
            </button>
            <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
              <button
                type="button"
                className={styles['btn-secondary']}
                onClick={() => {
                  const live = series.occurrences.find(
                    (o) =>
                      o.status === 'Scheduled' &&
                      !isPast(o.start_datetime) &&
                      o.id !== targetId,
                  );
                  if (live !== undefined) setTargetId(live.id);
                }}
              >
                Reschedule this one instead
              </button>
              <button
                type="button"
                className={styles['btn-danger']}
                disabled={busy || cancelled}
                onClick={() => setConfirmOpen(true)}
              >
                {cancelled ? 'Cancelled' : 'Cancel this occurrence'}
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* Confirmation modal (sits on top of the page) */}
      {confirmOpen && (
        <div className={styles['modal-backdrop']}>
          <div className={styles.modal}>
            <div className={styles['modal-head']}>
              <div className={styles['modal-icon']}>!</div>
              <div className={styles['modal-title-block']}>
                <div className={styles['modal-title']}>
                  Cancel {shortDate(target.occurrence.start_datetime)} at{' '}
                  {timeIn(target.occurrence.start_datetime, tz)}?
                </div>
                <div className={styles['modal-sub']}>
                  You&rsquo;re cancelling one visit, not the whole series.
                </div>
              </div>
              <button
                type="button"
                className={styles['modal-x']}
                aria-label="Close"
                onClick={() => setConfirmOpen(false)}
              >
                &times;
              </button>
            </div>
            <div className={styles['modal-body']}>
              <div className={styles['modal-target-strip']}>
                <strong>
                  Occurrence {target.ix} of {series.occurrence_count}
                </strong>{' '}
                · {shortDate(target.occurrence.start_datetime)} · {targetTime} ·{' '}
                {series.doctor_name}
              </div>
              <div className={styles['modal-lead']}>
                No reason needed. The{' '}
                {timeIn(target.occurrence.start_datetime, tz)} slot will be released and
                may be booked by another patient. The {scheduledCount} other upcoming
                visit{scheduledCount === 1 ? '' : 's'} in this series remain Scheduled.
              </div>
              <div className={styles['modal-rule']}>
                Per FR-049, each occurrence is independent after creation — only this
                one is affected.
              </div>
            </div>
            <div className={styles['modal-foot']}>
              <button
                type="button"
                className={styles['btn-ghost']}
                onClick={() => setConfirmOpen(false)}
              >
                Keep appointment
              </button>
              <button
                type="button"
                className={styles['btn-danger']}
                disabled={busy}
                onClick={onCancel}
              >
                {busy ? 'Cancelling…' : 'Cancel this occurrence'}
              </button>
            </div>
          </div>
        </div>
      )}
    </PatientFrame>
  );
}
