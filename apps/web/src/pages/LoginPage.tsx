/**
 * LoginPage — staff + patient entry.
 *
 * Two cards on the same 760px-stacked frame. Left = staff sign-in (admin /
 * doctor / receptionist) which calls `POST /auth/login/staff`. Right =
 * patient OTP (mockup 21) which calls `POST /patient/otp/verify-now`.
 *
 * Successful auth hands off to the parent (`App.tsx`) via the
 * `useAuth()` hook — the store updates, and the parent re-renders the
 * authenticated shell. Errors are surfaced inline; the helper text below
 * each form lists the seeded credentials a developer can copy/paste.
 */
import { useCallback, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { loginAsStaff, verifyPatientOtp } from '../auth/store';
import { BrandMark } from '../brand/BrandMark';
import styles from './LoginPage.module.css';

const STAFF_ROLES = [
  { value: 'admin', label: 'Administrator' },
  { value: 'doctor', label: 'Doctor' },
  { value: 'receptionist', label: 'Receptionist' },
] as const;

const E164_RE = /^\+[1-9]\d{6,14}$/;

interface FormError {
  status: number;
  code: string;
  message: string;
}

function describeApiError(err: unknown): FormError {
  if (err instanceof ApiError) {
    let message = err.code;
    if (err.code === 'staff_not_found') {
      message = 'No staff account matches that role + email.';
    } else if (err.code === 'invalid_email') {
      message = 'Enter a valid email address.';
    } else if (err.code === 'invalid_role') {
      message = 'Pick a role.';
    } else if (err.code === 'invalid_otp_code') {
      message = 'Invalid code. Try again.';
    } else if (err.code === 'invalid_phone') {
      message = 'Phone must include country code, e.g. +966 5… 5555.';
    } else if (err.status === 0 || err.code === 'network_error') {
      message = 'Connection failed. Is the API running on :3001?';
    } else if (err.status >= 500) {
      message = 'Server error. Try again in a moment.';
    }
    return { status: err.status, code: err.code, message };
  }
  return { status: 0, code: 'unknown_error', message: 'Unknown error.' };
}

export function LoginPage() {
  return (
    <div className={styles['frame']}>
      <nav className={styles['nav']}>
        <div className={styles['brand']}>
          <BrandMark size={28} className={styles['brand__logo']} />
          MediSlot
        </div>
        <div className={styles['nav__pill']}>Sign in</div>
      </nav>

      <div className={styles['page']}>
        <StaffCard />
        <PatientCard />
      </div>

      <div className={styles['privacy']}>
        All data is filtered server-side by your account. We never share your appointments.
        Authentication is required for every interaction with the clinic.
      </div>
    </div>
  );
}

// ─── Staff card ────────────────────────────────────────────────────────

function StaffCard() {
  const [role, setRole] = useState<'admin' | 'doctor' | 'receptionist'>(
    'admin',
  );
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<FormError | null>(null);

  const onSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setErr(null);
      setBusy(true);
      try {
        await loginAsStaff({ role, email: email.trim() });
      } catch (caught) {
        setErr(describeApiError(caught));
      } finally {
        setBusy(false);
      }
    },
    [role, email],
  );

  return (
    <form className={styles['card']} onSubmit={onSubmit} noValidate>
      <div className={styles['card__head']}>
        <div className={styles['card__icon']} aria-hidden="true">
          ◆
        </div>
        <div>
          <h2 className={styles['card__title']}>Staff sign-in</h2>
          <p className={styles['card__sub']}>
            Admin, doctor, or receptionist at your clinic.
          </p>
        </div>
      </div>

      <div className={styles['field']}>
        <label className={styles['field__label']} htmlFor="staff-role">
          Role
        </label>
        <select
          id="staff-role"
          className={styles['field__select']}
          value={role}
          onChange={(e) =>
            setRole(e.target.value as 'admin' | 'doctor' | 'receptionist')
          }
          disabled={busy}
        >
          {STAFF_ROLES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      <div className={styles['field']}>
        <label className={styles['field__label']} htmlFor="staff-email">
          Email<span className={styles['req']}>*</span>
        </label>
        <input
          id="staff-email"
          className={styles['field__input']}
          type="email"
          placeholder="you@clinic.local"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
          required
        />
      </div>

      {err && (
        <div className={styles['error-banner']} role="alert">
          <strong>{err.code}:</strong> {err.message}
        </div>
      )}

      <div className={styles['actions']}>
        <button
          type="submit"
          className={styles['btn-primary']}
          disabled={busy || email.trim().length === 0}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </div>

      <div className={styles['hint-block']}>
        <strong>Dev seed:</strong>{' '}
        <code>admin-main@clinic.local</code> (admin),{' '}
        <code>dr.-east-lead@clinic.local</code> (doctor),{' '}
        <code>receptionist-east@clinic.local</code> (receptionist). No password today
        — staff login is gated on email only (deferral W10a).
      </div>
    </form>
  );
}

// ─── Patient card ──────────────────────────────────────────────────────

function PatientCard() {
  const [phone, setPhone] = useState('');
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<FormError | null>(null);
  // Local attempts counter for mockup 21's "X attempts remaining" banner.
  // The mock-OTP route doesn't surface this today; decrement on each
  // invalid_otp_code response. Cleared on success / cancel.
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);
  const inputsRef = useRef<(HTMLInputElement | null)[]>([]);

  const onCancel = useCallback(() => {
    setDigits(['', '', '', '', '', '']);
    setErr(null);
    setAttemptsLeft(null);
  }, []);

  const code = digits.join('');
  const canSubmit =
    E164_RE.test(phone) && code.length === 6 && /^\d{6}$/.test(code);

  // Auto-advance the OTP cells as the user types or pastes.
  const handleDigit = useCallback(
    (idx: number, raw: string) => {
      const cleaned = raw.replace(/\D/g, '').slice(0, 6);
      if (cleaned.length > 1) {
        // Paste: spread across cells.
        const next = ['', '', '', '', '', ''];
        for (let i = 0; i < Math.min(cleaned.length, 6); i++) {
          next[i] = cleaned[i] ?? '';
        }
        setDigits(next);
        const focusIdx = Math.min(cleaned.length, 5);
        inputsRef.current[focusIdx]?.focus();
      } else {
        const next = [...digits];
        next[idx] = cleaned;
        setDigits(next);
        if (cleaned && idx < 5) {
          inputsRef.current[idx + 1]?.focus();
        }
      }
    },
    [digits],
  );

  // Backspace on an empty cell goes back to the previous cell.
  const handleKeyDown = useCallback(
    (idx: number, e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Backspace' && !digits[idx] && idx > 0) {
        inputsRef.current[idx - 1]?.focus();
      }
    },
    [digits],
  );

  const onSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setErr(null);
      setBusy(true);
      try {
        await verifyPatientOtp({ phone, code });
      } catch (caught) {
        const described = describeApiError(caught);
        setErr(described);
        // Decrement local attempts only on invalid-code errors. The mock
        // OTP route doesn't enforce this server-side yet — when the real
        // gateway lands, this banner is driven by the API.
        if (described.code === 'invalid_otp_code') {
          setAttemptsLeft((prev) => (prev === null ? 3 : Math.max(0, prev - 1)));
        }
      } finally {
        setBusy(false);
      }
    },
    [phone, code],
  );

  // Phone input keeps its plain `+` + digits value; the E.164 regex is
  // checked inside `canSubmit` at the top of the component.
  return (
    <form className={styles['card']} onSubmit={onSubmit} noValidate>
      <div className={styles['card__head']}>
        <div className={styles['card__icon']} aria-hidden="true">
          🔒
        </div>
        <div>
          <h2 className={styles['card__title']}>Patient sign-in</h2>
          <p className={styles['card__sub']}>
            Enter your phone number and the 6-digit code we sent you.
          </p>
        </div>
      </div>

      <div className={styles['field']}>
        <label className={styles['field__label']} htmlFor="patient-phone">
          Phone number<span className={styles['req']}>*</span>
        </label>
        <input
          id="patient-phone"
          className={styles['field__input']}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="+966 5XX XXX 5555"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          disabled={busy}
        />
        <span className={styles['field__hint']}>
          E.164 — include the country code (e.g. <code>+966…</code> or{' '}
          <code>+1…</code>).
        </span>
      </div>

      <div className={styles['field']}>
        <label className={styles['field__label']}>6-digit code</label>
        <div className={styles['otp']}>
          {digits.map((d, i) => (
            <input
              key={i}
              ref={(el) => {
                inputsRef.current[i] = el;
              }}
              className={
                `${styles['otp__cell']}` +
                (d ? ` ${styles['filled']}` : '') +
                (err ? ` ${styles['error']}` : '')
              }
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={d}
              onChange={(e) => handleDigit(i, e.target.value)}
              onKeyDown={(e) => handleKeyDown(i, e)}
              disabled={busy}
              aria-label={`Digit ${i + 1} of 6`}
            />
          ))}
        </div>
        <span className={styles['field__hint']}>
          Dev mode: use <code>123456</code>. The mock OTP route is dev/test-only;
          production replaces it with the real SMS gateway.
        </span>
      </div>

      {err && (
        <div className={styles['error-banner']} role="alert">
          <strong>{err.code}:</strong> {err.message}
        </div>
      )}

      <div className={styles['actions']}>
        <button
          type="button"
          className={styles['btn-ghost']}
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="submit"
          className={styles['btn-primary']}
          disabled={busy || !canSubmit}
        >
          {busy ? 'Verifying…' : 'Verify & continue'}
        </button>
      </div>
      {attemptsLeft !== null && attemptsLeft <= 2 && (
        <div className={styles['attempts-banner']} role="status">
          {attemptsLeft === 0
            ? 'Too many wrong codes. Try again in a minute.'
            : `${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} remaining.`}
        </div>
      )}

      <div className={styles['resend']}>
        Didn&apos;t get it?{' '}
        <a className={styles['disabled']}>
          Resend in <span className={styles['timer']}>0:28</span>
        </a>
      </div>

      <div className={styles['hint-block']}>
        <strong>Dev seed:</strong> patients are{' '}
        <code>+15550000001</code> through <code>+15550000005</code>. Pair with
        the code above.
      </div>
    </form>
  );
}