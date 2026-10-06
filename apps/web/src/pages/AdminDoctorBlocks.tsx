/**
 * Admin Doctor Blocks (Block time off) sub-page — under
 * `/admin/doctors/<id>/blocks` (reached via the "Block time" button on a
 * doctor card).
 *
 * Pixel-perfect port of mockup 10
 * (docs/design/mockups/v1/mockups/10-doctor-block-time.html). Driven by
 * the E2-S2 API surface:
 *   - `GET /admin/doctors/:id/blocks` — list existing blocks (for the
 *     "Existing blocks" panel + DELETE flow).
 *   - `POST /admin/doctors/:id/blocks-impact` — preview the count of
 *     future Scheduled appointments the proposed block would overlap.
 *   - `POST /admin/doctors/:id/blocks` — commit the block.
 *   - `DELETE /admin/doctors/:id/blocks/:block_id` — remove a block.
 *
 * Layout (mockup 10):
 *   - 760px frame.
 *   - 5 section cards stacked vertically:
 *     - **Step 1** — Pick type: radio row (Single date / Time range /
 *       Multi-day). "Time range" is the active default in the mockup;
 *       we ship "Time range" only for now (E2-S2 backend is a single
 *       `start_datetime`/`end_datetime` range per spec-2-2 line 36-43).
 *       Single date / multi-day are present as visual options but disabled
 *       with a "Not in MVP" tooltip (D-S2-1).
 *     - **Step 2** — When: start date + start time + end date + end time.
 *       Two-column date/time pickers per side.
 *     - **Step 3** — Where: branch select (default = "All my branches"
 *       if multiple, or single branch label) + reason textarea (optional).
 *     - **Step 4** — Impact preview: summary strip (Duration / Branches /
 *       Affected) + warn-card ("3 appointments fall in this period") +
 *       impact-list of affected appointments (when count > 0). Renders only
 *       after the user clicks "Preview impact" (or after a preview pass).
 *     - **Step 5** — Block & resolve: lead text + Cancel + Save draft +
 *       primary "Block & resolve N →" button.
 *   - Existing blocks panel below: a card listing the doctor's current
 *     blocks (id, branch, start–end range, reason, created_at) with a
 *     per-row "Delete" button. The mockup doesn't include this panel
 *     (the doctor's "Block time" was the entry point); admin needs a way
 *     to remove blocks so we surface it as a deferral note (D-S2-2).
 *
 * Branch field defaults to the first branch the doctor works at (per the
 * mockup's "Default = every branch you work at" hint). When the doctor
 * works at >1 branch the select is shown; with 1 branch the branch is
 * rendered as a static field (matches E2-S1 / E1-S3 pattern).
 *
 * The page is reached from the "Block time" button on each card in
 * `AdminDoctors.tsx`. The "← Back to doctors" button returns to the
 * card grid; AppShell stays on "doctors" so the nav still highlights
 * Doctors.
 *
 * No tests in this pass (per user instruction).
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
  createDoctorBlock,
  deleteDoctorBlock,
  getDoctor,
  listDoctorBlocks,
  previewDoctorBlockImpact,
  type AffectedScheduleAppointment,
  type DoctorBlockDto,
  type DoctorWithBranchesDto,
} from '../api/client';
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
    if (err.code === 'invalid_doctor_id') {
      message = 'Invalid doctor id.';
    } else if (err.code === 'doctor_not_found') {
      message = 'That doctor no longer exists.';
    } else if (err.code === 'invalid_branch_id') {
      message = 'A branch id is not a valid UUID.';
    } else if (err.code === 'invalid_block_id') {
      message = 'Invalid block id.';
    } else if (err.code === 'branch_not_in_doctor_branches') {
      message = 'The chosen branch is not one the doctor works at.';
    } else if (err.code === 'invalid_time_range') {
      message = 'End must be after start.';
    } else if (err.code === 'invalid_reason') {
      message = 'Reason must be 500 characters or fewer.';
    } else if (err.code === 'invalid_from_filter') {
      message = 'Invalid "from" filter (must be ISO datetime).';
    } else if (err.code === 'invalid_to_filter') {
      message = 'Invalid "to" filter (must be ISO datetime).';
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

export function AdminDoctorBlocks({
  doctorId,
  onBackToDoctors,
}: {
  doctorId: string;
  onBackToDoctors: () => void;
}) {
  const [doctor, setDoctor] = useState<DoctorWithBranchesDto | null>(null);
  const [blocks, setBlocks] = useState<DoctorBlockDto[]>([]);
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
  const [affected, setAffected] = useState<AffectedScheduleAppointment[]>([]);
  const [impactCount, setImpactCount] = useState<number>(0);

  // Save state.
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<FormError | null>(null);

  // ── Load ───────────────────────────────────────────────────────
  const reload = useCallback(async (): Promise<void> => {
    const doc = await getDoctor(doctorId);
    setDoctor(doc);
    if (doc.branches[0]) setBranchId(doc.branches[0].id);
    const { blocks: list } = await listDoctorBlocks(doctorId);
    setBlocks(list);
  }, [doctorId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadErr(null);
    reload()
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadErr(describeApiError(err));
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
      doctor?.branches.find((b) => b.id === id)?.name ?? id.slice(0, 8),
    [doctor],
  );

  // ── Validation ────────────────────────────────────────────────
  const clientValidation = useMemo(() => {
    if (!doctor) return { ok: true as const };
    if (!startDt || !endDt) {
      return { ok: false as const, code: 'invalid_time_range', message: 'Start and end are required.' };
    }
    const startIso = new Date(startDt).toISOString();
    const endIso = new Date(endDt).toISOString();
    if (!Number.isFinite(Date.parse(startIso)) || !Number.isFinite(Date.parse(endIso))) {
      return { ok: false as const, code: 'invalid_time_range', message: 'Start / end must be valid datetimes.' };
    }
    if (new Date(startIso) >= new Date(endIso)) {
      return { ok: false as const, code: 'invalid_time_range', message: 'End must be after start.' };
    }
    if (new Date(startIso) <= new Date()) {
      return { ok: false as const, code: 'start_in_past', message: 'Start must be in the future.' };
    }
    if (!branchId || !UUID_RE.test(branchId)) {
      return { ok: false as const, code: 'invalid_branch_id', message: 'A branch is required.' };
    }
    if (!doctor.branches.some((b) => b.id === branchId)) {
      return { ok: false as const, code: 'branch_not_in_doctor_branches', message: 'The chosen branch is not one the doctor works at.' };
    }
    if (reason.length > 500) {
      return { ok: false as const, code: 'invalid_reason', message: 'Reason must be 500 characters or fewer.' };
    }
    return { ok: true as const };
  }, [doctor, startDt, endDt, branchId, reason]);

  const canPreview =
    !loading &&
    !saving &&
    clientValidation.ok &&
    Boolean(doctor) &&
    blockType === 'range';

  const canSave =
    canPreview &&
    !previewing;

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
        const resp = await previewDoctorBlockImpact(doctorId, {
          branch_id: branchId,
          start_datetime: new Date(startDt).toISOString(),
          end_datetime: new Date(endDt).toISOString(),
          reason: reason.trim() === '' ? null : reason.trim(),
        });
        setAffected(resp.affected_appointments);
        setImpactCount(resp.future_appointment_count);
      } catch (caught) {
        setFormErr(describeApiError(caught));
      } finally {
        setPreviewing(false);
      }
    },
    [clientValidation, doctorId, branchId, startDt, endDt, reason],
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
    // Server is the source of truth on the impact check — it 409s if any
    // future Scheduled appointment overlaps the proposed block (FR-013,
    // BR-011). The preview above is purely advisory; we still POST and
    // surface the 409 if it returns one.
    setSaving(true);
    setFormErr(null);
    try {
      await createDoctorBlock(doctorId, {
        branch_id: branchId,
        start_datetime: new Date(startDt).toISOString(),
        end_datetime: new Date(endDt).toISOString(),
        reason: reason.trim() === '' ? null : reason.trim(),
      });
      // Reset the form to a fresh default and refresh the list.
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
  }, [clientValidation, doctorId, branchId, startDt, endDt, reason, reload]);

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
        await deleteDoctorBlock(doctorId, blockId);
        await reload();
      } catch (caught) {
        setFormErr(describeApiError(caught));
      } finally {
        setSaving(false);
      }
    },
    [doctorId, reload],
  );

  if (loading) {
    return (
      <div className={styles['page']}>
        <p className={styles['sub']}>Loading doctor…</p>
      </div>
    );
  }

  if (loadErr) {
    return (
      <div className={styles['page']}>
        <header className={styles['page-header']}>
          <button
            type="button"
            className={styles['btn-back']}
            onClick={onBackToDoctors}
          >
            ← Back to doctors
          </button>
        </header>
        <div className={styles['error-banner']} role="alert">
          <strong>{loadErr.code}:</strong> {loadErr.message}
        </div>
      </div>
    );
  }

  if (!doctor) return null;

  const branchOptions = doctor.branches;
  const hasMultipleBranches = branchOptions.length > 1;
  const previewSummary = {
    duration: durationHours(startDt, endDt),
    branchesLabel: hasMultipleBranches
      ? `All (${branchOptions.length} branches)`
      : branchName(branchId),
    affected: impactCount,
  };

  return (
    <div className={styles['page']}>
      <header className={styles['page-header']}>
        <div className={styles['crumb']}>
          Admin &rarr; Doctors &rarr; {doctor.full_name} &rarr; Block time
        </div>
        <div className={styles['page-header__row']}>
          <div>
            <h1>Block time off</h1>
            <p className={styles['sub']}>
              Mark dates when {doctor.full_name.replace(/^Dr\.?\s+/i, 'Dr. ')}{' '}
              can&rsquo;t see patients. Slots won&rsquo;t be offered.
            </p>
          </div>
          <button
            type="button"
            className={styles['btn-back']}
            onClick={onBackToDoctors}
          >
            ← Back to doctors
          </button>
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
              <div className={styles['opt__d']}>
                Consecutive days, all day
              </div>
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
              Block lives on one branch the doctor works at.
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
                {branchOptions.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            ) : (
              <div className={styles['form-control-static']}>
                {branchOptions[0]?.name ?? '—'}
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
            <div className={styles['char-count']}>
              {reason.length}/500
            </div>
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
                <strong>{impactCount} appointment{impactCount === 1 ? '' : 's'} fall{impactCount === 1 ? 's' : ''} in this period.</strong>{' '}
                Cancel / reschedule them before saving, or save the block
                anyway and resolve them in the doctor&rsquo;s today view.
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

      {/* ─── Existing blocks (admin only — D-S2-2) ─────── */}
      <section className={styles['section']}>
        <div className={styles['section-head']}>
          <div className={styles['section-num']}>📋</div>
          <div className={styles['section-head__body']}>
            <div className={styles['section-title']}>Existing blocks</div>
            <div className={styles['section-sub']}>
              {blocks.length} block{blocks.length === 1 ? '' : 's'} on file
              for this doctor.
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
  );
}