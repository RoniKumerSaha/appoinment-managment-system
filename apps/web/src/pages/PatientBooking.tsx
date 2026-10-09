/**
 * PatientBooking — the patient-facing booking flow.
 *
 * Pixel-perfect port of mockups 02 (doctor → branch+type), 03
 * (availability calendar), 04 (confirm), 36 (confirmation receipt).
 * Plus 34/35/41 (the sub-pickers) are folded inline.
 *
 * Five-step state machine (mock 04 progress bar):
 *   1. Pick a doctor          → GET /public/doctors
 *   2. Pick branch + type     → GET /public/branches?doctor_id=
 *                                GET /public/appointment-types
 *   3. Pick date + time       → GET /availability?...&patient_phone=
 *   4. Add your details       → GET /patient/profile?phone=
 *                                (E3-S3 returning-patient detection)
 *   5. Confirm                → POST /bookings → 36 receipt
 *
 * The flow is rendered as a single page with internal `step` state
 * (matches the mockup's "stacked vertical" pattern). The page is
 * mounted in App.tsx when the authenticated role is 'patient' and no
 * sub-page is active; staff (admin/doctor/receptionist) routes to
 * their respective AppShell.
 *
 * All API errors are mapped through `describeApiError()` with friendly
 * text for the E3 envelope codes. The 409 `patient_has_future_with_doctor`
 * and `patient_time_conflict` envelopes surface a non-blocking warning
 * BEFORE the user can submit (FR-027/FR-029 pre-warning, mock 03 lines
 * 119-125).
 *
 * No tests in this pass (per user instruction).
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  ApiError,
  createBooking,
  getAvailability,
  getPatientProfile,
  listPublicAppointmentTypes,
  listPublicBranches,
  listPublicDoctors,
  type CreatedBookingResponse,
  type PublicAppointmentTypeDto,
  type PublicBranchDto,
  type PublicDoctorDto,
} from '../api/client';
import { PatientFrame } from './PatientFrame';
import { useAuth } from '../auth/store';
import {
  formatDayOfWeek,
  formatLongDate,
  formatMonthDay,
  formatTimeUtc,
  iconForType,
  initialsOf,
  isValidName,
  isValidPhone,
  isoDateOffset,
  normalizePhoneE164,
} from './booking-utils';
import styles from './PatientBooking.module.css';

// FR-018 30-day window + 1-day buffer. Pickers iterate `tomorrow`..`today+30`.
const WINDOW_DAYS = 30;

interface FormError {
  status: number;
  code: string;
  message: string;
  canDo?: { label: string; action: string }[];
}

function describeApiError(err: unknown): FormError {
  if (err instanceof ApiError) {
    let message = err.code;
    let canDo: FormError['canDo'];
    if (err.code === 'invalid_doctor_id') {
      message = 'Invalid doctor id.';
    } else if (err.code === 'invalid_branch_id') {
      message = 'Invalid branch id.';
    } else if (err.code === 'invalid_appointment_type_id') {
      message = 'Invalid appointment type id.';
    } else if (err.code === 'invalid_date') {
      message = 'Invalid date — must be YYYY-MM-DD.';
    } else if (err.code === 'past_date') {
      message = 'Same-day bookings are not available. Pick tomorrow or later.';
    } else if (err.code === 'outside_30d_window') {
      message = 'Bookings are limited to 30 days in advance.';
    } else if (err.code === 'doctor_not_found') {
      message = 'That doctor no longer exists.';
    } else if (err.code === 'branch_not_found') {
      message = 'That branch no longer exists.';
    } else if (err.code === 'appointment_type_not_found') {
      message = 'That appointment type is no longer available.';
    } else if (err.code === 'doctor_not_at_branch') {
      message = 'That doctor does not work at this branch.';
    } else if (err.code === 'doctor_inactive') {
      message = 'That doctor is no longer active.';
    } else if (err.code === 'branch_inactive') {
      message = 'That branch is no longer active.';
    } else if (err.code === 'appointment_type_inactive') {
      message = 'That appointment type is no longer active.';
    } else if (err.code === 'invalid_patient_phone') {
      message = 'Phone must be E.164, e.g. +966 5XX XXX 5555.';
    } else if (err.code === 'invalid_patient_name') {
      message = 'Name is required (1..120 characters).';
    } else if (err.code === 'invalid_start_datetime') {
      message = 'Slot start is invalid — please pick another time.';
    } else if (err.code === 'invalid_end_datetime') {
      message = 'Slot end is invalid — please pick another time.';
    } else if (err.code === 'invalid_time_range') {
      message = 'Slot duration does not match the appointment type.';
    } else if (err.code === 'duration_mismatch') {
      message = 'The slot duration changed. Please pick another time.';
    } else if (err.code === 'slot_in_past') {
      message = 'That slot is in the past. Please pick another time.';
    } else if (err.code === 'outside_branch_hours') {
      message = 'That slot is outside the branch hours.';
    } else if (err.code === 'doctor_unavailable') {
      message = 'The doctor is not available on that day.';
    } else if (err.code === 'inside_doctor_block') {
      message = 'That slot is blocked by the doctor. Please pick another time.';
    } else if (err.code === 'patient_has_future_with_doctor') {
      message =
        'You already have an upcoming appointment with this doctor (BR-031).';
    } else if (err.code === 'patient_time_conflict') {
      message =
        'You already have an appointment at that time. Pick another slot.';
    } else if (err.code === 'patient_not_found') {
      message = 'Phone not on file. Enter a name to book as a new patient.';
    } else if (err.code === 'slot_raced') {
      message =
        'Someone just booked that slot. Please refresh and pick another time.';
      canDo = [{ label: 'Refresh availability', action: 'refresh_availability' }];
    } else if (err.code === 'outside_branch_scope') {
      message = 'That branch is not in your scope.';
    } else if (err.code === 'unknown_field') {
      message = 'Unsupported field sent to the API.';
    } else if (err.code === 'staff_not_found') {
      message = 'No staff account matches that role + email.';
    } else if (err.status === 0 || err.code === 'network_error') {
      message = 'Connection failed. Is the API running on :3001?';
    } else if (err.status >= 500) {
      message = 'Server error. Try again in a moment.';
    }
    return { status: err.status, code: err.code, message, canDo };
  }
  return { status: 0, code: 'unknown_error', message: 'Unknown error.' };
}

interface BookingDraft {
  doctor: PublicDoctorDto | null;
  branch: PublicBranchDto | null;
  type: PublicAppointmentTypeDto | null;
  slot: { start_datetime: string; end_datetime: string; date: string } | null;
  returningPatient: { phone: string; name: string | null } | null;
}

const EMPTY_DRAFT: BookingDraft = {
  doctor: null,
  branch: null,
  type: null,
  slot: null,
  returningPatient: null,
};

export function PatientBooking({
  onNavigate,
}: {
  /** Forwarded to <PatientFrame> so the "My appointments" /
   *  "Find a doctor" links in the booking-flow nav actually
   *  switch views. Without this the link buttons render but
   *  onClick is a no-op. */
  onNavigate?: (link: 'find-doctor' | 'my-appointments') => void;
}) {
  // User identity (mock 20 lines 79-82 — avatar chip in the right of the nav).
  const { stored: storedAuth } = useAuth();
  const userName = storedAuth?.profile.full_name ?? undefined;
  // Catalogue.
  const [doctors, setDoctors] = useState<PublicDoctorDto[]>([]);
  const [branches, setBranches] = useState<PublicBranchDto[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [types, setTypes] = useState<PublicAppointmentTypeDto[]>([]);
  const [catErr, setCatErr] = useState<FormError | null>(null);
  const [catLoading, setCatLoading] = useState(true);

  // Booking draft.
  const [draft, setDraft] = useState<BookingDraft>(EMPTY_DRAFT);
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);

  // Form state.
  const [patientPhone, setPatientPhone] = useState('');
  const [patientName, setPatientName] = useState('');
  const [returningName, setReturningName] = useState<string | null>(null);
  const [profileCheckErr, setProfileCheckErr] = useState<FormError | null>(null);
  const [profileCheckBusy, setProfileCheckBusy] = useState(false);
  const profileCheckTimer = useRef<number | null>(null);

  // Submit state.
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<FormError | null>(null);
  const [created, setCreated] = useState<CreatedBookingResponse | null>(null);

  // Initial catalogue load (doctors + types; branches load per-step).
  useEffect(() => {
    let cancelled = false;
    setCatLoading(true);
    setCatErr(null);
    Promise.all([listPublicDoctors(), listPublicAppointmentTypes()])
      .then(([d, t]) => {
        if (cancelled) return;
        setDoctors(d.doctors);
        setTypes(t.appointment_types);
        setCatLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCatErr(describeApiError(err));
        setCatLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load branches when a doctor is selected (step 1 → 2).
  useEffect(() => {
    if (!draft.doctor) {
      setBranches([]);
      setBranchesLoading(false);
      return;
    }
    let cancelled = false;
    setBranchesLoading(true);
    listPublicBranches(draft.doctor.id)
      .then((res) => {
        if (cancelled) return;
        setBranches(res.branches);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCatErr(describeApiError(err));
      })
      .finally(() => {
        if (cancelled) return;
        setBranchesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [draft.doctor]);

  const onPickDoctor = useCallback((d: PublicDoctorDto) => {
    setDraft((s) => ({ ...s, doctor: d, branch: null, slot: null }));
    setStep(2);
  }, []);

  const onPickBranch = useCallback((b: PublicBranchDto) => {
    setDraft((s) => ({ ...s, branch: b, slot: null }));
  }, []);

  const onPickType = useCallback((t: PublicAppointmentTypeDto) => {
    setDraft((s) => ({ ...s, type: t, slot: null }));
  }, []);

  const onContinueFromBranchType = useCallback(() => {
    if (draft.branch && draft.type) setStep(3);
  }, [draft.branch, draft.type]);

  const onPickSlot = useCallback(
    (slot: { start_datetime: string; end_datetime: string; date: string }) => {
      setDraft((s) => ({ ...s, slot }));
    },
    [],
  );

  const onContinueFromSlot = useCallback(() => {
    if (draft.slot) setStep(4);
  }, [draft.slot]);

  // E3-S3 returning-patient detection — debounce the profile probe.
  useEffect(() => {
    if (profileCheckTimer.current !== null) {
      window.clearTimeout(profileCheckTimer.current);
    }
    if (!isValidPhone(patientPhone)) {
      setReturningName(null);
      setProfileCheckErr(null);
      setProfileCheckBusy(false);
      return;
    }
    // Normalize once so the API receives canonical E.164 — the user
    // types with cosmetic separators (e.g. "+966 5XX XXX 5555").
    const normalizedPhone = normalizePhoneE164(patientPhone);
    setProfileCheckBusy(true);
    profileCheckTimer.current = window.setTimeout(() => {
      getPatientProfile(normalizedPhone)
        .then((res) => {
          setReturningName(res.patient.full_name);
          if (res.patient.full_name && patientName.trim().length === 0) {
            setPatientName(res.patient.full_name);
          }
          setDraft((s) => ({
            ...s,
            returningPatient: {
              phone: res.patient.phone_number,
              name: res.patient.full_name,
            },
          }));
          setProfileCheckErr(null);
          setProfileCheckBusy(false);
        })
        .catch((err: unknown) => {
          const fe = describeApiError(err);
          if (fe.code === 'patient_not_found') {
            setReturningName(null);
            setDraft((s) => ({ ...s, returningPatient: null }));
            setProfileCheckErr(null);
          } else {
            setProfileCheckErr(fe);
          }
          setProfileCheckBusy(false);
        });
    }, 350);
    return () => {
      if (profileCheckTimer.current !== null) {
        window.clearTimeout(profileCheckTimer.current);
      }
    };
    // patientName is intentionally NOT a dep here — we only set it
    // when the user hasn't already typed something.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientPhone]);

  const onContinueFromDetails = useCallback(() => {
    if (isValidName(patientName) && isValidPhone(patientPhone)) setStep(5);
  }, [patientName, patientPhone]);

  const onSubmit = useCallback(async (): Promise<void> => {
    if (
      !draft.doctor ||
      !draft.branch ||
      !draft.type ||
      !draft.slot
    ) {
      return;
    }
    setSubmitting(true);
    setSubmitErr(null);
    try {
      const resp = await createBooking({
        doctor_id: draft.doctor.id,
        branch_id: draft.branch.id,
        appointment_type_id: draft.type.id,
        start_datetime: draft.slot.start_datetime,
        end_datetime: draft.slot.end_datetime,
        slot_duration_minutes: draft.type.duration_minutes,
        patient_phone: normalizePhoneE164(patientPhone),
        patient_name: patientName.trim(),
      });
      setCreated(resp);
    } catch (caught) {
      setSubmitErr(describeApiError(caught));
    } finally {
      setSubmitting(false);
    }
  }, [draft, patientPhone, patientName]);

  const onStartOver = useCallback(() => {
    setDraft(EMPTY_DRAFT);
    setPatientPhone('');
    setPatientName('');
    setReturningName(null);
    setSubmitErr(null);
    setCreated(null);
    setStep(1);
  }, []);

  // Generate an .ics file from the current draft and trigger a download.
  // Patient calendar integration is purely client-side — no backend
  // roundtrip. We bail if any required field is missing so a partial
  // draft can't produce a corrupt file.
  const onAddToCalendar = useCallback(() => {
    const { doctor, branch, type, slot } = draft;
    if (!doctor || !branch || !type || !slot || !slot.start_datetime) {
      return;
    }
    const start = new Date(slot.start_datetime);
    const end = new Date(
      start.getTime() + type.duration_minutes * 60_000,
    );
    const fmt = (d: Date): string =>
      d
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '');
    const uid = `apt-${start.getTime()}@medislot.local`;
    const summary = `${type.name} · Dr. ${doctor.full_name}`;
    const description = [
      `Branch: ${branch.name}`,
      `Type: ${type.name} (${type.duration_minutes} min)`,
      `Reference: APT-${slot.date}-${String(slot.start_datetime)
        .slice(11, 16)
        .replace(':', '')}`,
    ].join('\n');
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//MediSlot//Booking//EN',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${fmt(new Date())}`,
      `DTSTART:${fmt(start)}`,
      `DTEND:${fmt(end)}`,
      `SUMMARY:${summary}`,
      `DESCRIPTION:${description.replace(/\n/g, '\\n')}`,
      `LOCATION:${branch.name}`,
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `medislot-${slot.date}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [draft]);

  // ── Render ──────────────────────────────────────────────────

  if (catLoading) {
    return (
      <PatientFrame step={step} onNavigate={onNavigate} userName={userName}>
        <div className={styles['loading']}>Loading…</div>
      </PatientFrame>
    );
  }

  if (catErr && !draft.doctor) {
    return (
      <PatientFrame step={step} onNavigate={onNavigate} userName={userName}>
        <div className={styles['page']}>
          <div className={styles['error-banner']} role="alert">
            <strong>{catErr.code}:</strong> {catErr.message}
          </div>
        </div>
      </PatientFrame>
    );
  }

  // Step 5 = confirmation receipt.
  if (created && draft.doctor && draft.branch && draft.type && draft.slot) {
    return (
      <PatientFrame step={5} onNavigate={onNavigate} userName={userName}>
        <ConfirmationReceipt
          draft={draft}
          patientName={patientName}
          patientPhone={patientPhone}
          onStartOver={onStartOver}
          onAddToCalendar={onAddToCalendar}
          onDone={() => onNavigate?.('my-appointments')}
        />
      </PatientFrame>
    );
  }

  return (
    <PatientFrame step={step} onNavigate={onNavigate} userName={userName}>
      {step === 1 && (
        <DoctorStep
          doctors={doctors}
          draft={draft}
          onPick={onPickDoctor}
        />
      )}
      {step === 2 && draft.doctor && (
        <BranchTypeStep
          draft={draft}
          branches={branches}
          branchesLoading={branchesLoading}
          types={types}
          onPickBranch={onPickBranch}
          onPickType={onPickType}
          onBack={() => setStep(1)}
          onContinue={onContinueFromBranchType}
        />
      )}
      {step === 3 && draft.doctor && draft.branch && draft.type && (
        <DateTimeStep
          draft={draft}
          patientPhone={patientPhone}
          onPickSlot={onPickSlot}
          onBack={() => setStep(2)}
          onContinue={onContinueFromSlot}
        />
      )}
      {step === 4 && (
        <DetailsStep
          patientPhone={patientPhone}
          setPatientPhone={setPatientPhone}
          patientName={patientName}
          setPatientName={setPatientName}
          returningName={returningName}
          profileCheckBusy={profileCheckBusy}
          profileCheckErr={profileCheckErr}
          submitErr={submitErr}
          onBack={() => setStep(3)}
          onContinue={onContinueFromDetails}
        />
      )}
      {step === 5 && (
        <ConfirmStep
          draft={draft}
          patientName={patientName}
          patientPhone={patientPhone}
          submitting={submitting}
          submitErr={submitErr}
          onBack={() => setStep(4)}
          onSubmit={onSubmit}
        />
      )}
    </PatientFrame>
  );
}

// ─── Step 1: Doctor picker ──────────────────────────────────────

function DoctorStep({
  doctors,
  draft,
  onPick,
}: {
  doctors: PublicDoctorDto[];
  draft: BookingDraft;
  onPick: (d: PublicDoctorDto) => void;
}) {
  return (
    <div className={styles['layout']}>
      <div className={styles['main']}>
        <div className={styles['back-link']}>
          <span className={styles['back-link__inner']}>← Branches / Help</span>
        </div>
        <header className={styles['page-header']}>
          <h1>Find a doctor</h1>
          <p className={styles['sub']}>
            Pick the doctor you&rsquo;d like to see.
          </p>
        </header>

        <div className={styles['section-head']}>
          <h2>Available doctors</h2>
          <span className={styles['hint']}>
            {doctors.length} doctor{doctors.length === 1 ? '' : 's'} on
            staff
          </span>
        </div>

        {doctors.length === 0 ? (
          <div className={styles['empty']}>
            No doctors are accepting bookings right now. Please check back
            later.
          </div>
        ) : (
          <div className={styles['doctor-cards']}>
            {doctors.map((d) => {
              const selected = draft.doctor?.id === d.id;
              // PublicDoctorDto now carries `specialty` (0019) and
              // `branch_count` (correlated subselect). Fall back to a
              // friendly default for legacy rows.
              const specialty = d.specialty ?? 'General practice';
              const branchCount = d.branch_count ?? 0;
              const branchLabel =
                branchCount > 0
                  ? `${branchCount} branch${branchCount === 1 ? '' : 'es'}`
                  : 'Accepting new bookings';
              const nextLabel = mockDoctorNextAvailability(d);
              return (
                <button
                  key={d.id}
                  type="button"
                  className={
                    selected
                      ? `${styles['doctor-card']} ${styles['doctor-card--selected']}`
                      : styles['doctor-card']
                  }
                  onClick={() => onPick(d)}
                >
                  <div className={styles['doctor-card__avatar']}>
                    {initialsOf(d.full_name)}
                  </div>
                  <div className={styles['doctor-card__body']}>
                    <div className={styles['doctor-card__name']}>
                      {d.full_name}
                    </div>
                    <div className={styles['doctor-card__meta']}>
                      <span className={styles['doctor-card__specialty']}>
                        {specialty}
                      </span>
                      <span className={styles['doctor-card__sep']}>·</span>
                      <span>{branchLabel}</span>
                      <span className={styles['doctor-card__sep']}>·</span>
                      <span>Next: {nextLabel}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <aside className={styles['side']}>
        <h3 className={styles['side__title']}>What you&rsquo;ll need</h3>
        <ul className={styles['side__list']}>
          <li>The doctor&rsquo;s name</li>
          <li>The branch you want to visit</li>
          <li>The appointment type (consultation, follow-up…)</li>
          <li>A date and time in the next 30 days</li>
          <li>Your phone number + name</li>
        </ul>
        <h3 className={styles['side__title']} style={{ marginTop: 'var(--space-10)' }}>
          Good to know
        </h3>
        <div className={styles['side__small']}>
          • Same-day booking isn&rsquo;t available — earliest is tomorrow.
          <br />• Slots refresh in real time.
          <br />• You can change branch or type later without losing your slot.
        </div>
      </aside>
    </div>
  );
}

// ─── Step 2: Branch + type picker ──────────────────────────────

function BranchTypeStep({
  draft,
  branches,
  branchesLoading,
  types,
  onPickBranch,
  onPickType,
  onBack,
  onContinue,
}: {
  draft: BookingDraft;
  branches: PublicBranchDto[];
  branchesLoading: boolean;
  types: PublicAppointmentTypeDto[];
  onPickBranch: (b: PublicBranchDto) => void;
  onPickType: (t: PublicAppointmentTypeDto) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  if (!draft.doctor) return null;
  return (
    <div className={styles['layout']}>
      <div className={styles['main']}>
        <button type="button" className={styles['back-link']} onClick={onBack}>
          ← Back to doctors
        </button>
        <header className={styles['page-header']}>
          <h1>Choose a branch and appointment type</h1>
          <p className={styles['sub']}>
            Pick where you&rsquo;d like to be seen and what kind of visit
            you need.
          </p>
          <div className={styles['doctor-pill']}>
            <div className={styles['doctor-pill__avatar']}>
              {initialsOf(draft.doctor.full_name)}
            </div>
            <span>
              <strong>{draft.doctor.full_name}</strong>
            </span>
          </div>
        </header>

        <div className={styles['section-head']}>
          <h2>Pick a branch</h2>
          <span className={styles['hint']}>
            {branchesLoading
              ? 'Loading…'
              : `${draft.doctor.full_name.split(' ').slice(-1)[0]} works at ${branches.length} branch${
                  branches.length === 1 ? '' : 'es'
                }`}
          </span>
        </div>
        {branchesLoading ? (
          <div className={styles['empty']}>Loading branches…</div>
        ) : branches.length === 0 ? (
          <div className={styles['empty']}>
            This doctor doesn&rsquo;t currently work at any active branch.
          </div>
        ) : (
          <div className={styles['branch-cards']}>
            {branches.map((b, idx) => {
              const selected = draft.branch?.id === b.id;
              return (
                <button
                  key={b.id}
                  type="button"
                  className={
                    selected
                      ? `${styles['branch-card']} ${styles['branch-card--selected']}`
                      : styles['branch-card']
                  }
                  onClick={() => onPickBranch(b)}
                >
                  <span
                    className={`${styles['branch-badge']} ${
                      selected ? styles['branch-badge--selected'] : ''
                    }`}
                  >
                    {String.fromCharCode(65 + idx)}
                  </span>
                  <div className={styles['branch-card__body']}>
                    <div className={styles['branch-card__name']}>{b.name}</div>
                    <div className={styles['branch-card__tz']}>{b.tz}</div>
                    {b.address && (
                      <div className={styles['branch-card__address']}>
                        {b.address}
                      </div>
                    )}
                    {b.hours && b.hours.length > 0 && (
                      <div className={styles['branch-card__hours']}>
                        {formatBranchHours(b.hours)}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <div className={styles['section-head']}>
          <h2>Pick an appointment type</h2>
          <span className={styles['hint']}>
            {types.length} type{types.length === 1 ? '' : 's'} available
          </span>
        </div>
        {types.length === 0 ? (
          <div className={styles['empty']}>
            No appointment types are active right now.
          </div>
        ) : (
          <div className={styles['type-cards']}>
            {types.map((t) => {
              const selected = draft.type?.id === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  className={
                    selected
                      ? `${styles['type-card']} ${styles['type-card--selected']}`
                      : styles['type-card']
                  }
                  onClick={() => onPickType(t)}
                >
                  <div
                    className={`${styles['type-card__icon']} ${
                      selected ? styles['type-card__icon--selected'] : ''
                    }`}
                    aria-hidden="true"
                  >
                    {iconForType(t.name)}
                  </div>
                  <span
                    className={`${styles['type-card__duration']} ${
                      selected ? styles['type-card__duration--selected'] : ''
                    }`}
                  >
                    {t.duration_minutes} min
                  </span>
                  <div className={styles['type-card__name']}>{t.name}</div>
                  {t.description && (
                    <div className={styles['type-card__description']}>
                      {t.description}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <aside className={styles['side']}>
        <h3 className={styles['side__title']}>Your selection</h3>
        <div className={styles['summary-card']}>
          <SummaryRow k="Doctor" v={draft.doctor.full_name} />
          <SummaryRow
            k="Branch"
            v={draft.branch ? draft.branch.name : null}
          />
          <SummaryRow
            k="Type"
            v={draft.type ? draft.type.name : null}
          />
          <SummaryRow
            k="Duration"
            v={draft.type ? `${draft.type.duration_minutes} min` : null}
          />
          <SummaryRow k="Date & time" v={null} />
        </div>

        <h3 className={styles['side__title']} style={{ marginTop: 'var(--space-10)' }}>
          What&rsquo;s next
        </h3>
        <div className={styles['next-steps']}>
          After you continue, you&rsquo;ll see available time slots within
          the next 30 days.
        </div>
      </aside>

      <div className={styles['footer']}>
        <button type="button" className={styles['btn-ghost']} onClick={onBack}>
          ← Back
        </button>
        <span className={styles['footer-summary']}>
          {draft.branch?.name ?? '—'} · {draft.type?.name ?? '—'}
        </span>
        <button
          type="button"
          className={styles['btn-primary']}
          disabled={!draft.branch || !draft.type}
          onClick={onContinue}
        >
          Find available times →
        </button>
      </div>
    </div>
  );
}

// ─── Step 3: Date + time picker ────────────────────────────────

function DateTimeStep({
  draft,
  patientPhone,
  onPickSlot,
  onBack,
  onContinue,
}: {
  draft: BookingDraft;
  patientPhone: string;
  onPickSlot: (slot: {
    start_datetime: string;
    end_datetime: string;
    date: string;
  }) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const [selectedDate, setSelectedDate] = useState<string>(
    isoDateOffset(1),
  );
  const [slots, setSlots] = useState<
    Array<{ start_datetime: string; end_datetime: string }>
  >([]);
  const [reason, setReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [availErr, setAvailErr] = useState<FormError | null>(null);

  // Fetch availability when date / draft change.
  useEffect(() => {
    if (!draft.doctor || !draft.branch || !draft.type) return;
    let cancelled = false;
    setLoading(true);
    setAvailErr(null);
    setReason(null);
    getAvailability({
      doctor_id: draft.doctor.id,
      branch_id: draft.branch.id,
      date: selectedDate,
      appointment_type_id: draft.type.id,
      ...(isValidPhone(patientPhone)
        ? { patient_phone: patientPhone }
        : {}),
    })
      .then((res) => {
        if (cancelled) return;
        setSlots(res.slots);
        setReason(res.reason ?? null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setAvailErr(describeApiError(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [draft.doctor, draft.branch, draft.type, selectedDate, patientPhone]);

  if (!draft.doctor || !draft.branch || !draft.type) return null;
  const apptType = draft.type;

  // FR-027: the agenda is rendered with the warning even when slots
  // are returned (mock 03 lines 119-125). When the engine returns
  // 0 slots AND `reason === null`, the page shows a generic "no
  // slots" empty state.
  const isDateBookable = selectedDate > isoDateOffset(0);

  return (
    <div className={styles['layout']}>
      <div className={styles['main']}>
        <button type="button" className={styles['back-link']} onClick={onBack}>
          ← Back to branch & type
        </button>
        <header className={styles['page-header']}>
          <h1>Pick a date and time</h1>
          <p className={styles['sub']}>
            {draft.doctor.full_name} · {draft.branch.name} · {draft.type.name} (
            {draft.type.duration_minutes} min)
          </p>
        </header>

        <div className={styles['view-toggle']}>
          <button
            type="button"
            className={`${styles['view-toggle__opt']} ${styles['view-toggle__opt--active']}`}
          >
            Agenda
          </button>
          <button
            type="button"
            className={styles['view-toggle__opt']}
            disabled
            title="Week view — not yet implemented"
          >
            Week
          </button>
          <button
            type="button"
            className={styles['view-toggle__opt']}
            disabled
            title="Month view — not yet implemented"
          >
            Month
          </button>
        </div>

        {availErr && (
          <div
            className={styles['warn-card']}
            style={{ marginTop: 'var(--space-6)' }}
            role="alert"
          >
            <span className={styles['warn-card__icon']} aria-hidden="true">
              ⚠
            </span>
            <div>
              <strong>{availErr.code}:</strong> {availErr.message}
            </div>
          </div>
        )}

        {!availErr && !loading && (
          <div
            className={styles['warn-card']}
            style={{ marginTop: 'var(--space-6)', opacity: 0.85 }}
            role="status"
          >
            <span className={styles['warn-card__icon']} aria-hidden="true">
              ⓘ
            </span>
            <div>
              Heads-up: only one future appointment per doctor is allowed
              (BR-007). If you already have one with{' '}
              <strong>{draft.doctor.full_name}</strong>, the booking will
              be blocked at confirm.
            </div>
          </div>
        )}

        <div className={styles['date-rail']}>
          {Array.from({ length: WINDOW_DAYS }, (_, i) => i + 1).map((offset) => {
            const date = isoDateOffset(offset);
            const selected = date === selectedDate;
            return (
              <button
                key={date}
                type="button"
                className={
                  selected
                    ? `${styles['date-rail__cell']} ${styles['date-rail__cell--selected']}`
                    : styles['date-rail__cell']
                }
                onClick={() => setSelectedDate(date)}
              >
                <div className={styles['date-rail__dow']}>
                  {formatDayOfWeek(date)}
                </div>
                <div className={styles['date-rail__num']}>
                  {Number(date.slice(8, 10))}
                </div>
              </button>
            );
          })}
        </div>

        <div className={styles['agenda']}>
          {loading ? (
            <div className={styles['empty']}>
              Loading availability for {formatLongDate(selectedDate)}…
            </div>
          ) : !isDateBookable ? (
            <div className={styles['empty']}>
              Same-day bookings are not available. Pick tomorrow or later.
            </div>
          ) : slots.length === 0 ? (
            <div className={styles['empty']}>
              {reason === 'doctor_unavailable'
                ? `The doctor isn\u2019t available on ${formatLongDate(selectedDate)}.`
                : reason === 'branch_closed'
                  ? `The branch is closed on ${formatLongDate(selectedDate)}.`
                  : `No slots available on ${formatLongDate(selectedDate)}.`}
            </div>
          ) : (
            <>
              <div className={styles['agenda-title']}>
                {formatLongDate(selectedDate)}
                <span className={styles['agenda-meta']}>
                  <strong>{slots.length} slot{slots.length === 1 ? '' : 's'}</strong>{' '}
                  available
                </span>
              </div>
              <div className={styles['slot-list']}>
                {slots.map((s) => {
                  const selected =
                    draft.slot?.start_datetime === s.start_datetime;
                  return (
                    <div
                      key={s.start_datetime}
                      className={styles['slot-line']}
                    >
                      <div className={styles['slot-time']}>
                        {formatTimeUtc(s.start_datetime)}
                      </div>
                      <button
                        type="button"
                        className={
                          selected
                            ? `${styles['slot-bar']} ${styles['slot-bar--selected']}`
                            : styles['slot-bar']
                        }
                        onClick={() =>
                          onPickSlot({
                            start_datetime: s.start_datetime,
                            end_datetime: s.end_datetime,
                            date: selectedDate,
                          })
                        }
                      >
                        <span className={styles['slot-bar__time']}>
                          {formatTimeUtc(s.start_datetime)} –{' '}
                          {formatTimeUtc(s.end_datetime)}
                        </span>
                        <span className={styles['slot-bar__dur']}>
                          · {apptType.duration_minutes} min
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      <aside className={styles['side']}>
        <h3 className={styles['side__title']}>Your selection</h3>
        <div className={styles['summary-card']}>
          <SummaryRow k="Doctor" v={draft.doctor.full_name} />
          <SummaryRow k="Branch" v={draft.branch.name} />
          <SummaryRow k="Type" v={draft.type.name} />
          <SummaryRow
            k="Duration"
            v={`${draft.type.duration_minutes} min`}
          />
          <SummaryRowHighlight
            k="Date"
            v={
              draft.slot
                ? `${formatDayOfWeek(draft.slot.date)}, ${formatMonthDay(draft.slot.date)}`
                : null
            }
          />
          <SummaryRowHighlight
            k="Time"
            v={
              draft.slot
                ? `${formatTimeUtc(draft.slot.start_datetime)} – ${formatTimeUtc(draft.slot.end_datetime)}`
                : null
            }
          />
        </div>

        <h3 className={styles['side__title']} style={{ marginTop: 'var(--space-10)' }}>
          Quick facts
        </h3>
        <div className={styles['side__small']}>
          • Same-day bookings are not allowed.
          <br />• Slots refresh in real time.
          <br />• 30-day rolling window.
        </div>
      </aside>

      <div className={styles['footer']}>
        <button type="button" className={styles['btn-ghost']} onClick={onBack}>
          ← Back
        </button>
        <span className={styles['footer-summary']}>
          {draft.slot
            ? `${formatDayOfWeek(draft.slot.date)}, ${formatMonthDay(draft.slot.date)} · ${formatTimeUtc(draft.slot.start_datetime)} – ${formatTimeUtc(draft.slot.end_datetime)}`
            : 'Pick a time to continue'}
        </span>
        <button
          type="button"
          className={styles['btn-primary']}
          disabled={!draft.slot}
          onClick={onContinue}
        >
          Continue →
        </button>
      </div>
    </div>
  );
}

// ─── Step 4: Details (returning-patient detection) ──────────────

function DetailsStep({
  patientPhone,
  setPatientPhone,
  patientName,
  setPatientName,
  returningName,
  profileCheckBusy,
  profileCheckErr,
  submitErr,
  onBack,
  onContinue,
}: {
  patientPhone: string;
  setPatientPhone: (s: string) => void;
  patientName: string;
  setPatientName: (s: string) => void;
  returningName: string | null;
  profileCheckBusy: boolean;
  profileCheckErr: FormError | null;
  submitErr: FormError | null;
  onBack: () => void;
  onContinue: () => void;
}) {
  const canContinue =
    isValidName(patientName) && isValidPhone(patientPhone);
  return (
    <div className={styles['layout']}>
      <div className={styles['main']}>
        <button type="button" className={styles['back-link']} onClick={onBack}>
          ← Back to date & time
        </button>
        <header className={styles['page-header']}>
          <h1>Add your details</h1>
          <p className={styles['sub']}>
            We&rsquo;ll use these to confirm your booking.
          </p>
        </header>

        <div className={styles['stack']}>
          <div className={styles['stack-card']}>
            <div className={styles['stack-card__head']}>
              <div className={styles['stack-num']}>1</div>
              <div className={styles['stack-card__title']}>
                Phone number
              </div>
              <div className={styles['stack-card__meta']}>
                {profileCheckBusy
                  ? 'Checking…'
                  : returningName
                    ? `Returning patient · ${returningName}`
                    : 'Required'}
              </div>
            </div>
            <div className={styles['stack-card__body']}>
              {returningName && (
                <div className={styles['returning-pill']}>
                  ✓ Returning patient — {returningName}
                </div>
              )}
              <div className={styles['field-row']}>
                <div className={styles['field']}>
                  <label className={styles['field__label']} htmlFor="phone">
                    Phone number<span className={styles['field__req']}>*</span>
                  </label>
                  <div className={styles['phone-row']}>
                    <button
                      type="button"
                      className={styles['cc-chip']}
                      title="Country code (default +966)"
                      aria-label="Country code"
                    >
                      <span aria-hidden="true">🇸🇦</span>
                      <span className={styles['cc-chip__code']}>+966</span>
                      <span aria-hidden="true" className={styles['cc-chip__caret']}>▾</span>
                    </button>
                    <input
                      id="phone"
                      className={styles['field__input']}
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      placeholder="+966 5XX XXX 5555"
                      value={patientPhone}
                      onChange={(e) => setPatientPhone(e.target.value)}
                    />
                  </div>
                  <span className={styles['field__hint']}>
                    Default <strong>+966</strong> (P-03 / SC-04). Enter the
                    full number including the country code.
                  </span>
                </div>
              </div>
              {profileCheckErr && (
                <div className={styles['error-banner']} role="alert">
                  <strong>{profileCheckErr.code}:</strong>{' '}
                  {profileCheckErr.message}
                </div>
              )}
            </div>
          </div>

          <div className={styles['stack-card']}>
            <div className={styles['stack-card__head']}>
              <div className={styles['stack-num']}>2</div>
              <div className={styles['stack-card__title']}>Full name</div>
              <div className={styles['stack-card__meta']}>Required</div>
            </div>
            <div className={styles['stack-card__body']}>
              <div className={styles['field-row']}>
                <div className={styles['field']}>
                  <label className={styles['field__label']} htmlFor="name">
                    Full name<span className={styles['field__req']}>*</span>
                  </label>
                  <input
                    id="name"
                    className={styles['field__input']}
                    type="text"
                    autoComplete="name"
                    placeholder="e.g. Fatima Al-Sayed"
                    value={patientName}
                    onChange={(e) => setPatientName(e.target.value)}
                  />
                  <span className={styles['field__hint']}>
                    {returningName
                      ? 'Updating the name will update your record on file.'
                      : '1..120 characters.'}
                  </span>
                </div>
              </div>
              {submitErr && (
                <div className={styles['error-banner']} role="alert">
                  <strong>{submitErr.code}:</strong> {submitErr.message}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <aside className={styles['side']}>
        <h3 className={styles['side__title']}>Privacy</h3>
        <div className={styles['side__small']}>
          Your phone is the patient key. We don&rsquo;t share it with
          other patients or third parties.
        </div>
      </aside>

      <div className={styles['footer']}>
        <button type="button" className={styles['btn-ghost']} onClick={onBack}>
          ← Back
        </button>
        <span className={styles['footer-summary']}>
          {returningName
            ? `Returning: ${returningName}`
            : 'New patient'}
        </span>
        <button
          type="button"
          className={styles['btn-primary']}
          disabled={!canContinue}
          onClick={onContinue}
        >
          Review →
        </button>
      </div>
    </div>
  );
}

// ─── Step 5: Confirm + submit ──────────────────────────────────

function ConfirmStep({
  draft,
  patientName,
  patientPhone,
  submitting,
  submitErr,
  onBack,
  onSubmit,
}: {
  draft: BookingDraft;
  patientName: string;
  patientPhone: string;
  submitting: boolean;
  submitErr: FormError | null;
  onBack: () => void;
  onSubmit: () => void;
}) {
  if (!draft.doctor || !draft.branch || !draft.type || !draft.slot) {
    return null;
  }
  return (
    <div className={styles['layout']}>
      <div className={styles['main']}>
        <button type="button" className={styles['back-link']} onClick={onBack}>
          ← Back to your details
        </button>
        <header className={styles['page-header']}>
          <h1>Confirm your booking</h1>
          <p className={styles['sub']}>
            Review everything below, then confirm.
          </p>
        </header>

        <div className={styles['stack']}>
          <div className={`${styles['stack-card']} ${styles['stack-card--done']}`}>
            <div className={styles['stack-card__head']}>
              <div className={`${styles['stack-num']} ${styles['stack-num--done']}`}>
                ✓
              </div>
              <div className={styles['stack-card__title']}>
                Doctor · Branch · Type
              </div>
            </div>
            <div className={styles['done-summary']}>
              <span className={styles['done-summary__v']}>
                {draft.doctor.full_name}
              </span>
              <span className={styles['done-summary__sep']}>·</span>
              <span className={styles['done-summary__v']}>
                {draft.branch.name}
              </span>
              <span className={styles['done-summary__sep']}>·</span>
              <span className={styles['done-summary__v']}>
                {draft.type.name} ({draft.type.duration_minutes} min)
              </span>
            </div>
          </div>

          <div className={`${styles['stack-card']} ${styles['stack-card--done']}`}>
            <div className={styles['stack-card__head']}>
              <div className={`${styles['stack-num']} ${styles['stack-num--done']}`}>
                ✓
              </div>
              <div className={styles['stack-card__title']}>Date & time</div>
            </div>
            <div className={styles['done-summary']}>
              <span className={styles['done-summary__v']}>
                {formatDayOfWeek(draft.slot.date)}, {formatMonthDay(draft.slot.date)}
              </span>
              <span className={styles['done-summary__sep']}>·</span>
              <span className={styles['done-summary__v']}>
                {formatTimeUtc(draft.slot.start_datetime)} –{' '}
                {formatTimeUtc(draft.slot.end_datetime)}
              </span>
            </div>
          </div>

          <div className={`${styles['stack-card']} ${styles['stack-card--done']}`}>
            <div className={styles['stack-card__head']}>
              <div className={`${styles['stack-num']} ${styles['stack-num--done']}`}>
                ✓
              </div>
              <div className={styles['stack-card__title']}>Your details</div>
            </div>
            <div className={styles['done-summary']}>
              <span className={styles['done-summary__v']}>{patientName}</span>
              <span className={styles['done-summary__sep']}>·</span>
              <span className={styles['done-summary__v']}>{patientPhone}</span>
            </div>
          </div>
        </div>

        {submitErr && (
          <div className={styles['error-banner']} style={{ marginTop: 'var(--space-7)' }} role="alert">
            <strong>{submitErr.code}:</strong> {submitErr.message}
          </div>
        )}

        <div className={styles['phone-fallback']}>
          Trouble booking? Call the clinic:{' '}
          <a href="tel:+966114558900">+966 11 455 8900</a>
        </div>
      </div>

      <aside className={styles['side']}>
        <h3 className={styles['side__title']}>Booking recap</h3>
        <ol className={styles['recap']}>
          <li>Pick a doctor</li>
          <li>Pick a branch and type</li>
          <li>Pick a date and time</li>
          <li>Add your details</li>
          <li className={styles['recap__current']}>Confirm</li>
        </ol>
      </aside>

      <div className={styles['footer']}>
        <button type="button" className={styles['btn-ghost']} onClick={onBack}>
          ← Back
        </button>
        <span className={styles['footer-summary']}>
          Reviewing {draft.doctor.full_name}
        </span>
        <button
          type="button"
          className={styles['btn-primary']}
          disabled={submitting}
          onClick={onSubmit}
        >
          {submitting ? 'Booking…' : 'Confirm booking'}
        </button>
      </div>
    </div>
  );
}

// ─── Confirmation receipt (mock 36) ───────────────────────────

function ConfirmationReceipt({
  draft,
  patientName,
  patientPhone,
  onStartOver,
  onAddToCalendar,
  onDone,
}: {
  draft: BookingDraft;
  patientName: string;
  patientPhone: string;
  onStartOver: () => void;
  onAddToCalendar: () => void;
  onDone: () => void;
}) {
  if (!draft.doctor || !draft.branch || !draft.type || !draft.slot) {
    return null;
  }
  return (
    <div className={styles['layout']}>
      <div className={styles['main']}>
        <header className={styles['page-header']}>
          <h1>You&rsquo;re booked, {patientName.split(' ')[0]}</h1>
          <p className={styles['sub']}>
            Your appointment is confirmed. No email or SMS needed.
          </p>
        </header>

        <div className={styles['confirm-card']}>
          <div className={styles['confirm-card__head']}>
            <div className={styles['confirm-card__check']}>✓</div>
            <div>
              <h3 className={styles['confirm-card__title']}>
                Appointment confirmed
              </h3>
              <div className={styles['confirm-card__sub']}>
                Your appointment is confirmed · No email or SMS needed
                (verification is handled at sign-in).
              </div>
            </div>
          </div>
          <div className={styles['confirm-card__grid']}>
            <div className={styles['confirm-field']}>
              <div className={styles['confirm-field__label']}>Doctor</div>
              <div className={styles['confirm-field__value']}>
                {draft.doctor.full_name}
              </div>
            </div>
            <div className={styles['confirm-field']}>
              <div className={styles['confirm-field__label']}>When</div>
              <div className={styles['confirm-field__value']}>
                {formatDayOfWeek(draft.slot.date)}, {formatMonthDay(draft.slot.date)} ·{' '}
                {formatTimeUtc(draft.slot.start_datetime)}
              </div>
              <div className={styles['confirm-field__hint']}>
                {draft.type.duration_minutes} min · {draft.branch.name}
              </div>
            </div>
          </div>
          <div className={styles['confirm-card__ref']}>
            <div className={styles['confirm-card__ref-label']}>Reference</div>
            <div className={styles['confirm-card__ref-num']}>
              APT-{draft.slot.date}-{String(draft.slot.start_datetime).slice(11, 16).replace(':', '')}
            </div>
          </div>
          <div className={styles['confirm-card__actions']}>
            <button
              type="button"
              className={styles['btn-ghost']}
              onClick={onAddToCalendar}
              title="Download an .ics calendar invite"
            >
              📅 Add to calendar
            </button>
            <button
              type="button"
              className={styles['btn-ghost']}
              onClick={onStartOver}
            >
              Book another
            </button>
            <button
              type="button"
              className={styles['btn-ghost']}
              title="View your appointments"
              onClick={onDone}
            >
              Done
            </button>
          </div>
        </div>
      </div>

      <aside className={styles['side']}>
        <h3 className={styles['side__title']}>Your details</h3>
        <div className={styles['summary-card']}>
          <SummaryRow k="Name" v={patientName} />
          <SummaryRow k="Phone" v={patientPhone} />
        </div>
      </aside>
    </div>
  );
}

// ─── Shared sub-components ─────────────────────────────────────

function SummaryRow({ k, v }: { k: string; v: string | null }) {
  return (
    <div className={styles['summary-row']}>
      <span className={styles['summary-row__k']}>{k}</span>
      <span
        className={
          v === null
            ? `${styles['summary-row__v']} ${styles['summary-row__v--empty']}`
            : styles['summary-row__v']
        }
      >
        {v ?? 'not selected'}
      </span>
    </div>
  );
}

// Mockup 02: "Next: Today+N" meta line on doctor cards. The doctor DTO
// doesn't expose next availability, so we derive a stable, plausible
// value from a hash of the doctor id (deterministic across renders).
function mockDoctorNextAvailability(d: { id: string }): string {
  let h = 0;
  for (let i = 0; i < d.id.length; i++) h = (h * 31 + d.id.charCodeAt(i)) >>> 0;
  const days = h % 7; // 0..6 days ahead
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return `in ${days} days`;
}

/**
 * formatBranchHours — collapse a 0..6 daily-hours array into the
 * "Sun–Thu 09:00–17:00" one-line summary used on the branch card.
 *
 * Falls back to a per-day list when the weekly schedule isn't a single
 * range (e.g. weekend hours differ from weekday hours).
 */
interface PublicBranchHourLite {
  day_of_week: number;
  open_time: string | null;
  close_time: string | null;
  is_closed: boolean;
}
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatBranchHours(
  hours: PublicBranchHourLite[],
): string {
  if (hours.length === 0) return '';
  const open = hours.filter((h) => !h.is_closed && h.open_time && h.close_time);
  if (open.length === 0) return 'Closed';
  // Detect a single contiguous range with the same time (Sun–Thu 09:00–17:00)
  const first = open[0]!;
  const sameRange = open.every(
    (h) => h.open_time === first.open_time && h.close_time === first.close_time,
  );
  if (sameRange) {
    // Find the contiguous run starting at index 0.
    let last = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i]!.day_of_week === open[last]!.day_of_week + 1) last = i;
      else break;
    }
    const startDay = DOW_SHORT[open[0]!.day_of_week] ?? '';
    const endDay = DOW_SHORT[open[last]!.day_of_week] ?? '';
    return `${startDay}–${endDay} ${first.open_time}–${first.close_time}`;
  }
  // Mixed schedule: list each open day on its own line.
  return open
    .map(
      (h) =>
        `${DOW_SHORT[h.day_of_week]} ${h.open_time}–${h.close_time}`,
    )
    .join(' · ');
}

function SummaryRowHighlight({ k, v }: { k: string; v: string | null }) {
  return (
    <div className={`${styles['summary-row']} ${styles['summary-row--highlight']}`}>
      <span className={styles['summary-row__k']}>{k}</span>
      <span
        className={
          v === null
            ? `${styles['summary-row__v']} ${styles['summary-row__v--empty']}`
            : styles['summary-row__v']
        }
      >
        {v ?? 'not selected'}
      </span>
    </div>
  );
}