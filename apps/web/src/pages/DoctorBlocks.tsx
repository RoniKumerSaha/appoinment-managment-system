/**
 * DoctorBlocks — the doctor's own "Block time off" page
 * (`#/doctor?page=blocks`).
 *
 * `docs/design/user-flows/doctor.md` Act 2 lists "Block time" as a
 * DOCTOR section, and mockup 10 is the design for it. The only
 * implementation was `AdminDoctorBlocks` — an admin page at
 * `#/admin/doctors/<id>/blocks`, backed by routes under `/admin`
 * that `app.ts` gates behind `adminScope`. A doctor could not
 * declare their own time off.
 *
 * This page is the doctor-facing counterpart: the same five-step
 * flow (mock 10) — pick type → when → where → impact preview →
 * block & resolve — plus the existing-blocks panel, bound to the
 * signed-in doctor:
 *
 *   - No doctor picker. The server binds the doctor id from
 *     `claim.doctor_id`; there is no `:doctor_id` in the path.
 *   - The branch list comes from the staff catalogue.
 *   - Preview / create / delete go through the new doctor-scoped
 *     routes, which apply the admin route's validation and
 *     transactional semantics exactly.
 *
 * The CSS is shared with the admin page
 * (`AdminDoctorBlocks.module.css`) — it is a faithful port of
 * mockup 10 and token-only, so there is no reason to fork it.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import {
  ApiError,
  createMyDoctorBlock,
  deleteMyDoctorBlock,
  listMyDoctorBlocks,
  listStaffBranches,
  previewMyDoctorBlock,
  type BranchDto,
  type DoctorBlock,
} from '../api/client';
import { DoctorFrame } from './DoctorFrame';
import styles from './AdminDoctorBlocks.module.css';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type BlockType = 'single' | 'range' | 'multi';

interface FormError {
  status: number;
  code: string;
  message: string;
}

function describeApiError(err: unknown): FormError {
  if (err instanceof ApiError) {
    let message = err.code;
    if (err.code === 'invalid_branch_id') {
      message = 'Invalid branch id.';
    } else if (err.code === 'invalid_block_id') {
      message = 'Invalid block id.';
    } else if (err.code === 'branch_not_in_doctor_branches') {
      message = 'The chosen branch is not one you work at.';
    } else if (err.code === 'invalid_time_range') {
      message = 'End must be after start.';
    } else if (err.code === 'invalid_reason') {
      message = 'Reason must be 500 characters or fewer.';
    } else if (err.code === 'start_in_past') {
      message = 'Start must be in the future.';
    } else if (err.code === 'block_overlaps_future_appointments') {
      message =
        'This block overlaps future Scheduled appointments. Cancel / reschedule them first.';
    } else if (err.code === 'block_not_found') {
      message = 'That block no longer exists.';
    } else if (err.code === 'unknown_field') {
      message = 'Unsupported field sent to the API.';
    } else if (err.status === 0 || err.code === 'network_error') {
      message = 'Connection failed. Is the API running on :3001?';
    } else if (err.status >= 500) {
      message = 'Server error. Try again in a moment.';
    }
    return { status: err.status, code: err.code, message };
  }
  return { status: 0, code: 'unknown_error', message: 'Unknown error.' };
}

function toDateInputValue(iso: string): string {
  // YYYY-MM-DDTHH:MM
  return iso.slice(0, 16);
}

function inOneHourDateTimeLocal(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function inFourHoursDateTimeLocal(): string {
  const d = new Date(Date.now() + 4 * 60 * 60 * 1000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function durationHours(start: string, end: string): number {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 0;
  return (e - s) / (60 * 60 * 1000);
}

function formatLongDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${d.getUTCDate()} · ${hh}:${mi} UTC`;
}

export function DoctorBlocks({ activeNav }: { activeNav?: string }) {
  const [blocks, setBlocks] = useState<DoctorBlock[]>([]);
  const [branches, setBranches] = useState<BranchDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<FormError | null>(null);

  // Form state.
  const [blockType, setBlockType] = useState<BlockType>('range');
  const [startDt, setStartDt] = useState<string>(inOneHourDateTimeLocal());
  const [endDt, setEndDt] = useState<string>(inFourHoursDateTimeLocal());
  const [branchId, setBranchId] = useState<string>('');
  const [reason, setReason] = useState<string>('');

  // Preview state.
  const [previewing, setPreviewing] = useState(false);
  const [affected, setAffected] = useState<
    Array<{
      id: string;
      patient_phone_masked: string;
      branch_id: string;
      start_datetime: string;
      status: string;
    }>
  >([]);
  const [impactCount, setImpactCount] = useState<number>(0);

  // Save state.
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<FormError | null>(null);

  // ── Load ───────────────────────────────────────────────────────
  const reload = useCallback(async (): Promise<void> => {
    const [{ blocks: list }, branchList] = await Promise.all([
      listMyDoctorBlocks(),
      listStaffBranches('active'),
    ]);
    setBlocks(list);
    setBranches(branchList);
    setBranchId((prev) => prev || branchList[0]?.id || '');
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadErr(null);
    reload()
      .catch((err: unknown) => {
        if (!cancelled) setLoadErr(describeApiError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const branchName = useCallback(
    (id: string): string =>
      branches.find((b) => b.id === id)?.name ?? id.slice(0, 8),
    [branches],
  );

  // ── Validation ────────────────────────────────────────────────
  const clientValidation = useMemo(() => {
    if (!startDt || !endDt) {
      return {
        ok: false as const,
        code: 'invalid_time_range',
        message: 'Start and end are required.',
      };
    }
    const startIso = new Date(startDt).toISOString();
    const endIso = new Date(endDt).toISOString();
    if (
      !Number.isFinite(Date.parse(startIso)) ||
      !Number.isFinite(Date.parse(endIso))
    ) {
      return {
        ok: false as const,
        code: 'invalid_time_range',
        message: 'Start / end must be valid datetimes.',
      };
    }
    if (new Date(startIso) >= new Date(endIso)) {
      return {
        ok: false as const,
        code: 'invalid_time_range',
        message: 'End must be after start.',
      };
    }
    if (new Date(startIso) <= new Date()) {
      return {
        ok: false as const,
        code: 'start_in_past',
        message: 'Start must be in the future.',
      };
    }
    if (!branchId || !UUID_RE.test(branchId)) {
      return {
        ok: false as const,
        code: 'invalid_branch_id',
        message: 'A branch is required.',
      };
    }
    if (!branches.some((b) => b.id === branchId)) {
      return {
        ok: false as const,
        code: 'branch_not_in_doctor_branches',
        message: 'The chosen branch is not one you work at.',
      };
    }
    if (reason.length > 500) {
      return {
        ok: false as const,
        code: 'invalid_reason',
        message: 'Reason must be 500 characters or fewer.',
      };
    }
    return { ok: true as const };
  }, [branches, startDt, endDt, branchId, reason]);

  const canPreview =
    !loading && !saving && clientValidation.ok && blockType === 'range';

  const canSave = canPreview && !previewing;

  // ── Preview ─────────────────────────────────────────────────────
  const onPreview = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!clientValidation.ok) {
        setFormErr({
          status: 400,
          code: clientValidation.code,
          message: clientValidation.message,
        });
        return;
      }
      setFormErr(null);
      setPreviewing(true);
      try {
        const resp = await previewMyDoctorBlock({
          branch_id: branchId,
          start_datetime: new Date(startDt).toISOString(),
          end_datetime: new Date(endDt).toISOString(),
          reason: reason.trim() === '' ? undefined : reason.trim(),
        });
        setAffected(resp.affected_appointments);
        setImpactCount(resp.future_appointment_count);
      } catch (caught) {
        setFormErr(describeApiError(caught));
      } finally {
        setPreviewing(false);
      }
    },
    [clientValidation, branchId, startDt, endDt, reason],
  );

  // ── Save ──────────────────────────────────────────────────────
  const onSave = useCallback(async () => {
    if (!clientValidation.ok) {
      setFormErr({
        status: 400,
        code: clientValidation.code,
        message: clientValidation.message,
      });
      return;
    }
    // The server is the source of truth on the impact check — it 409s
    // if any future Scheduled appointment overlaps the proposed block
    // (FR-013, BR-011). The preview above is advisory.
    setSaving(true);
    setFormErr(null);
    try {
      await createMyDoctorBlock({
        branch_id: branchId,
        start_datetime: new Date(startDt).toISOString(),
        end_datetime: new Date(endDt).toISOString(),
        reason: reason.trim() === '' ? undefined : reason.trim(),
      });
      setStartDt(inOneHourDateTimeLocal());
      setEndDt(inFourHoursDateTimeLocal());
      setReason('');
      setAffected([]);
      setImpactCount(0);
      setSavedAt(new Date().toISOString());
      await reload();
    } catch (caught) {
      setFormErr(describeApiError(caught));
    } finally {
      setSaving(false);
    }
  }, [clientValidation, branchId, startDt, endDt, reason, reload]);

  const onCancel = useCallback(() => {
    setStartDt(inOneHourDateTimeLocal());
    setEndDt(inFourHoursDateTimeLocal());
    setReason('');
    setAffected([]);
    setImpactCount(0);
    setFormErr(null);
  }, []);

  const onDeleteBlock = useCallback(
    async (blockId: string) => {
      if (!UUID_RE.test(blockId)) return;
      setFormErr(null);
      setSaving(true);
      try {
        await deleteMyDoctorBlock(blockId);
        await reload();
      } catch (caught) {
        setFormErr(describeApiError(caught));
      } finally {
        setSaving(false);
      }
    },
    [reload],
  );

  if (loading) {
    return (
      <DoctorFrame activeNav={activeNav}>
        <div className={styles['page']}>
          <p className={styles['sub']}>Loading blocks…</p>
        </div>
      </DoctorFrame>
    );
  }

  if (loadErr) {
    return (
      <DoctorFrame activeNav={activeNav}>
        <div className={styles['page']}>
          <div className={styles['error-banner']} role="alert">
            <strong>{loadErr.code}:</strong> {loadErr.message}
          </div>
        </div>
      </DoctorFrame>
    );
  }

  const hasMultipleBranches = branches.length > 1;
  const previewSummary = {
    duration: durationHours(startDt, endDt),
    branchesLabel: hasMultipleBranches
      ? `All (${branches.length} branches)`
      : branchName(branchId),
    affected: impactCount,
  };

  return (
    <DoctorFrame activeNav={activeNav}>
      <div className={styles['page']}>
        <header className={styles['page-header']}>
          <div className={styles['crumb']}>Doctor &rarr; Block time</div>
          <div className={styles['page-header__row']}>
            <div>
              <h1>Block time off</h1>
              <p className={styles['sub']}>
                Mark dates when you can&rsquo;t see patients. Slots
                won&rsquo;t be offered.
              </p>
            </div>
          </div>
        </header>

        {/* ─── Step 1: Pick type ──────────────────────────── */}
        <section className={styles['section']}>
          <div className={styles['section-head']}>
            <div className={styles['section-num']}>1</div>
            <div className={styles['section-head__body']}>
              <div className={styles['section-title']}>What kind of block?</div>
              <div className={styles['section-sub']}>
                Time range only in this MVP (single date + multi-day are
                disabled).
              </div>
            </div>
          </div>
          <div className={styles['section-body']}>
            <div className={styles['radio-row']}>
              <button
                type="button"
                className={
                  blockType === 'single'
                    ? `${styles['opt']} ${styles['opt--selected']}`
                    : styles['opt']
                }
                onClick={() => setBlockType('single')}
                disabled
                title="Not in MVP — single date is encoded as a zero-duration range"
              >
                <div className={styles['opt__l']}>📅 Single date</div>
                <div className={styles['opt__d']}>
                  One whole day or part of one
                </div>
              </button>
              <button
                type="button"
                className={
                  blockType === 'range'
                    ? `${styles['opt']} ${styles['opt--selected']}`
                    : styles['opt']
                }
                onClick={() => setBlockType('range')}
              >
                <div className={styles['opt__l']}>⏰ Time range</div>
                <div className={styles['opt__d']}>Specific hours</div>
              </button>
              <button
                type="button"
                className={
                  blockType === 'multi'
                    ? `${styles['opt']} ${styles['opt--selected']}`
                    : styles['opt']
                }
                onClick={() => setBlockType('multi')}
                disabled
                title="Not in MVP — multi-day blocks live in a future story"
              >
                <div className={styles['opt__l']}>🗓️ Multi-day</div>
                <div className={styles['opt__d']}>Consecutive days, all day</div>
              </button>
            </div>
          </div>
        </section>

        {/* ─── Step 2: When ────────────────────────────────── */}
        <section className={styles['section']}>
          <div className={styles['section-head']}>
            <div
              className={`${styles['section-num']} ${styles['section-num--current']}`}
            >
              2
            </div>
            <div className={styles['section-head__body']}>
              <div className={styles['section-title']}>When?</div>
              <div className={styles['section-sub']}>
                End must be after start. Start must be in the future.
              </div>
            </div>
          </div>
          <div className={styles['section-body']}>
            <div className={styles['form-group']}>
              <label className={styles['form-label']}>Start</label>
              <div className={styles['row']}>
                <input
                  type="datetime-local"
                  className={styles['form-control']}
                  value={toDateInputValue(startDt)}
                  onChange={(e) => setStartDt(e.target.value)}
                  disabled={saving}
                />
              </div>
            </div>
            <div className={styles['form-group']}>
              <label className={styles['form-label']}>End</label>
              <div className={styles['row']}>
                <input
                  type="datetime-local"
                  className={styles['form-control']}
                  value={toDateInputValue(endDt)}
                  onChange={(e) => setEndDt(e.target.value)}
                  disabled={saving}
                />
              </div>
            </div>
          </div>
        </section>

        {/* ─── Step 3: Where ────────────────────────────────── */}
        <section className={styles['section']}>
          <div className={styles['section-head']}>
            <div className={styles['section-num']}>3</div>
            <div className={styles['section-head__body']}>
              <div className={styles['section-title']}>Where?</div>
              <div className={styles['section-sub']}>
                Block lives on one branch you work at.
              </div>
            </div>
          </div>
          <div className={styles['section-body']}>
            <div className={styles['form-group']}>
              <label className={styles['form-label']}>Branch</label>
              {hasMultipleBranches ? (
                <select
                  className={styles['form-control']}
                  value={branchId}
                  onChange={(e) => setBranchId(e.target.value)}
                  disabled={saving}
                >
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              ) : (
                <div className={styles['form-control-static']}>
                  {branches[0]?.name ?? '—'}
                </div>
              )}
            </div>
            <div className={styles['form-group']}>
              <label className={styles['form-label']}>
                Reason <span className={styles['hint']}>(internal only)</span>
              </label>
              <textarea
                className={styles['form-control']}
                placeholder="e.g. conference, vacation…"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                disabled={saving}
                rows={3}
              />
              <div className={styles['char-count']}>{reason.length}/500</div>
            </div>
          </div>
        </section>

        {/* ─── Step 4: Impact preview ─────────────────────── */}
        <form className={styles['section']} onSubmit={onPreview} noValidate>
          <div className={styles['section-head']}>
            <div className={styles['section-num']}>4</div>
            <div className={styles['section-head__body']}>
              <div className={styles['section-title']}>Impact preview</div>
              <div className={styles['section-sub']}>
                Server checks future Scheduled appointments in this range.
              </div>
            </div>
          </div>
          <div className={styles['section-body']}>
            <div className={styles['summary-strip']}>
              <div className={styles['summary-item']}>
                <div className={styles['summary-item__k']}>Duration</div>
                <div className={styles['summary-item__v']}>
                  {previewSummary.duration > 0
                    ? `${previewSummary.duration % 1 === 0 ? previewSummary.duration : previewSummary.duration.toFixed(1)} hour${previewSummary.duration === 1 ? '' : 's'}`
                    : '—'}
                </div>
              </div>
              <div className={styles['summary-item']}>
                <div className={styles['summary-item__k']}>Branches</div>
                <div className={styles['summary-item__v']}>
                  {previewSummary.branchesLabel}
                </div>
              </div>
              <div className={styles['summary-item']}>
                <div className={styles['summary-item__k']}>Affected</div>
                <div className={styles['summary-item__v']}>
                  {previewing
                    ? '…'
                    : impactCount === 0 && affected.length === 0
                      ? 'Not yet previewed'
                      : `${impactCount} appointment${impactCount === 1 ? '' : 's'}`}
                </div>
              </div>
            </div>

            {!previewing &&
              !formErr &&
              affected.length === 0 &&
              impactCount === 0 && (
                <p className={styles['preview-hint']}>
                  Click <strong>Preview impact</strong> to ask the server how
                  many future appointments fall in this range.
                </p>
              )}

            {!previewing && impactCount > 0 && (
              <>
                <div className={styles['warn-card']}>
                  <strong>
                    {impactCount} appointment{impactCount === 1 ? '' : 's'} fall
                    {impactCount === 1 ? 's' : ''} in this period.
                  </strong>{' '}
                  Cancel / reschedule them before saving, or save the block
                  anyway and resolve them in your today view.
                </div>

                <div className={styles['impact-list-label']}>Affected</div>
                <div className={styles['impact-list']}>
                  {affected.map((a) => (
                    <div key={a.id} className={styles['impact-row']}>
                      <span className={styles['impact-row__when']}>
                        {formatLongDateTime(a.start_datetime)}
                      </span>
                      <span className={styles['impact-row__who']}>
                        <code>{a.patient_phone_masked}</code> · Branch{' '}
                        {branchName(a.branch_id)}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className={styles['section-actions']}>
              <button
                type="submit"
                className={styles['btn-secondary']}
                disabled={!canPreview}
              >
                {previewing ? 'Previewing…' : 'Preview impact'}
              </button>
            </div>
          </div>
        </form>

        {/* ─── Step 5: Block & resolve ─────────────────────── */}
        <section className={styles['section']}>
          <div className={styles['section-head']}>
            <div className={styles['section-num']}>5</div>
            <div className={styles['section-head__body']}>
              <div className={styles['section-title']}>Block &amp; resolve</div>
              <div className={styles['section-sub']}>
                Atomic. Slot becomes unavailable immediately after save.
              </div>
            </div>
          </div>
          <div className={styles['section-body']}>
            <p className={styles['lead']}>
              On save, the block is created. The server will 409 if any future
              Scheduled appointment overlaps the range (FR-013, BR-011); cancel
              or reschedule those first, then return here.
            </p>

            {formErr && (
              <div className={styles['error-banner']} role="alert">
                <strong>{formErr.code}:</strong> {formErr.message}
              </div>
            )}

            {savedAt && (
              <div className={styles['success-banner']} role="status">
                ✓ Block saved at {formatLongDateTime(savedAt)}.
              </div>
            )}
          </div>
          <div className={styles['section-actions']}>
            <button
              type="button"
              className={styles['btn-ghost']}
              onClick={onCancel}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className={styles['btn-secondary']}
              disabled
              title="Not in MVP — drafts land in a future story"
            >
              Save as draft
            </button>
            <button
              type="button"
              className={styles['btn-primary']}
              disabled={!canSave}
              onClick={() => {
                void onSave();
              }}
            >
              {saving
                ? 'Saving…'
                : impactCount > 0
                  ? `Block & resolve ${impactCount} →`
                  : 'Block →'}
            </button>
          </div>
        </section>

        {/* ─── Existing blocks ───────────────────────────── */}
        <section className={styles['section']}>
          <div className={styles['section-head']}>
            <div className={styles['section-num']}>📋</div>
            <div className={styles['section-head__body']}>
              <div className={styles['section-title']}>Your blocks</div>
              <div className={styles['section-sub']}>
                {blocks.length} block{blocks.length === 1 ? '' : 's'} on file.
              </div>
            </div>
          </div>
          <div className={styles['section-body']}>
            {blocks.length === 0 && (
              <div className={styles['empty']}>No blocks yet.</div>
            )}
            {blocks.map((b) => (
              <div key={b.id} className={styles['block-row']}>
                <div className={styles['block-row__body']}>
                  <div className={styles['block-row__when']}>
                    {formatLongDateTime(b.start_datetime)} →{' '}
                    {formatLongDateTime(b.end_datetime)}
                  </div>
                  <div className={styles['block-row__meta']}>
                    Branch: {branchName(b.branch_id)} ·{' '}
                    {b.reason ?? <em>no reason</em>} · created{' '}
                    {formatLongDateTime(b.created_at)}
                  </div>
                </div>
                <button
                  type="button"
                  className={styles['btn-period-del']}
                  onClick={() => {
                    void onDeleteBlock(b.id);
                  }}
                  disabled={saving}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>
    </DoctorFrame>
  );
}
