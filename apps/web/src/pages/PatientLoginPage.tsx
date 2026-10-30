/**
 * PatientLoginPage — the patient sign-in screen (`#/login/patient`).
 *
 * Split out of `LoginPage.tsx`, which used to render this form and
 * the staff form as two cards side by side. A patient never saw a
 * role dropdown or a password field, and a staff member never saw an
 * OTP widget — now neither sees the other's form.
 *
 * The phone field and the six OTP cells stay on ONE page (rather than
 * the two-step flow the mockup suggests) so the whole sign-in is one
 * step. The behaviour is unchanged: the same field ids, the same
 * auto-advancing cells, the same error mapping, the same attempts
 * banner.
 */
import { useCallback, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { verifyPatientOtp } from '../auth/store';
import { LoginFrame } from './LoginFrame';
import { OtpIcon, PhoneIcon } from './LoginIcons';
import { LOGIN_STAFF_HASH, LOGIN_CHOOSE_HASH, pushLoginRoute } from './login-routes';
import styles from './LoginPage.module.css';

const E164_RE = /^\+[1-9]\d{6,14}$/;

interface FormError {
  status: number;
  code: string;
  message: string;
}

function describeApiError(err: unknown): FormError {
  if (err instanceof ApiError) {
    let message = err.code;
    if (err.code === 'invalid_credentials') {
      message = 'That email and password combination is not valid.';
    } else if (err.code === 'invalid_email') {
      message = 'Enter a valid email address.';
    } else if (err.code === 'invalid_role') {
      message = 'Pick a role.';
    } else if (err.code === 'password_required') {
      message = 'Enter your password.';
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

export function PatientLoginPage() {
  const [phone, setPhone] = useState('');
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<FormError | null>(null);
  // Local attempts counter for mockup 21's "X attempts remaining" banner.
  // The mock-OTP route doesn't surface this today; decrement on each
  // invalid_otp_code response. Cleared on success / cancel.
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);
  const inputsRef = useRef<(HTMLInputElement | null)[]>([]);

  const onCancel = useCallback((): void => {
    setDigits(['', '', '', '', '', '']);
    setErr(null);
    setAttemptsLeft(null);
    // On a standalone page, Cancel means "go back" — return to the
    // chooser rather than leaving the patient on a dead-end form.
    pushLoginRoute('choose');
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
        const focusIdx = Math.min(cleaned.length - 1, 5);
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
    <LoginFrame>
      <form
        className={styles['card']}
        onSubmit={onSubmit}
        noValidate
        data-testid="patient-login"
      >
        <div className={styles['card__head']}>
          <div
            className={`${styles['card__icon']} ${styles['card__icon--patient']}`}
            aria-hidden="true"
          >
            <OtpIcon />
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
          <div className={styles['field__shell']}>
            <PhoneIcon className={styles['field__shellIcon']} />
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
          </div>
          <span className={styles['field__hint']}>
            E.164 — include the country code (e.g. <code>+966…</code> or{' '}
            <code>+1…</code>).
          </span>
        </div>

        <div className={styles['field']}>
          <span className={styles['field__label']}>6-digit code</span>
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
            Demo mode: use <code>123456</code>. The mock OTP route is
            dev/test-only; production replaces it with the real SMS gateway.
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
          <strong>Demo patients:</strong> <code>+15550000001</code> through{' '}
          <code>+15550000005</code>, plus <code>+966501110001</code>–<code>+966501110005</code>.
          Pair any of them with the code above.
        </div>

        <div className={styles['switch']}>
          <a href={LOGIN_CHOOSE_HASH} data-testid="patient-login-back">
            ← Back
          </a>
          <a href={LOGIN_STAFF_HASH} data-testid="patient-login-to-staff">
            Staff member? Staff sign-in →
          </a>
        </div>
      </form>
    </LoginFrame>
  );
}
