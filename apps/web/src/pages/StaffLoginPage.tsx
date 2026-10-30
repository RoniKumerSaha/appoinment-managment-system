/**
 * StaffLoginPage — the staff sign-in screen (`#/login/staff`).
 *
 * Split out of `LoginPage.tsx`, which used to render this form and
 * the patient OTP form as two cards side by side. The behaviour is
 * unchanged: the same field ids, the same `password_required` guard,
 * the same error mapping, the same dev-seed hint.
 *
 * The password is REQUIRED. It used to be optional, and a blank field
 * fell through to the API's dev-only email-only path — which minted a
 * valid token for anyone who knew a seeded email address. Every staff
 * account now carries a `password_hash`, so the stub path serves no
 * purpose and only widens the hole. The form refuses it in the UI so
 * it cannot silently authenticate without one.
 */
import { useCallback, useState } from 'react';
import { ApiError } from '../api/client';
import { loginAsStaff } from '../auth/store';
import { LoginFrame } from './LoginFrame';
import { EyeIcon, EyeOffIcon, KeyIcon, MailIcon, StaffIcon } from './LoginIcons';
import { LOGIN_PATIENT_HASH, LOGIN_CHOOSE_HASH } from './login-routes';
import styles from './LoginPage.module.css';

const STAFF_ROLES = [
  { value: 'admin', label: 'Administrator' },
  { value: 'doctor', label: 'Doctor' },
  { value: 'receptionist', label: 'Receptionist' },
] as const;

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
    } else if (err.code === 'invalid_credentials') {
      message = 'That email and password combination is not valid.';
    } else if (err.code === 'invalid_email') {
      message = 'Enter a valid email address.';
    } else if (err.code === 'invalid_role') {
      message = 'Pick a role.';
    } else if (err.code === 'password_required') {
      message = 'Enter your password.';
    } else if (err.status === 0 || err.code === 'network_error') {
      message = 'Connection failed. Is the API running on :3001?';
    } else if (err.status >= 500) {
      message = 'Server error. Try again in a moment.';
    }
    return { status: err.status, code: err.code, message };
  }
  return { status: 0, code: 'unknown_error', message: 'Unknown error.' };
}

export function StaffLoginPage() {
  const [role, setRole] = useState<'admin' | 'doctor' | 'receptionist'>(
    'admin',
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<FormError | null>(null);
  // Whether the password is shown in clear. Default hidden, as a
  // password field should be on a shared screen.
  const [showPassword, setShowPassword] = useState(false);

  const onSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setErr(null);
      // The password is REQUIRED.
      //
      // It used to be optional, and a blank field fell through to the
      // API's dev-only email-only path — which minted a valid token for
      // anyone who knew a seeded email address. Every staff account
      // now carries a `password_hash`, so the stub path serves no
      // purpose and only widens the hole. Refuse it in the UI so the
      // form cannot silently authenticate without one.
      if (password.length === 0) {
        setErr({
          status: 400,
          code: 'password_required',
          message: 'Enter your password.',
        });
        return;
      }
      setBusy(true);
      try {
        await loginAsStaff({
          role,
          email: email.trim(),
          password,
        });
      } catch (caught) {
        setErr(describeApiError(caught));
      } finally {
        setBusy(false);
      }
    },
    [role, email, password],
  );

  return (
    <LoginFrame>
      <form
        className={styles['card']}
        onSubmit={onSubmit}
        noValidate
        data-testid="staff-login"
      >
        <div className={styles['card__head']}>
          <div className={styles['card__icon']} aria-hidden="true">
            <StaffIcon />
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
          <div className={styles['field__shell']}>
            <MailIcon className={styles['field__shellIcon']} />
            <input
              id="staff-email"
              className={styles['field__input']}
              type="email"
              placeholder="you@clinic.com"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              required
            />
          </div>
        </div>

        <div className={styles['field']}>
          <label className={styles['field__label']} htmlFor="staff-password">
            Password<span className={styles['req']}>*</span>
          </label>
          <div
            className={`${styles['field__shell']} ${styles['field__shell--action']}`}
          >
            <KeyIcon className={styles['field__shellIcon']} />
            <input
              id="staff-password"
              className={styles['field__input']}
              type={showPassword ? 'text' : 'password'}
              placeholder="••••••••••••"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              required
            />
            <button
              type="button"
              className={styles['field__toggle']}
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              title={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
          <span className={styles['field__hint']}>
            Your clinic password. Ask an administrator to reset it if you
            have forgotten it.
          </span>
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
            disabled={busy || email.trim().length === 0 || password.length === 0}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>

        <div className={styles['hint-block']}>
          <strong>Demo accounts:</strong>{' '}
          <code>admin@clinic.com</code> (admin),{' '}
          <code>doctor@clinic.com</code> (doctor),{' '}
          <code>reception@clinic.com</code> (receptionist). Password
          for all three in dev: <code>Clinic@12345678</code>.
        </div>

        <div className={styles['switch']}>
          <a href={LOGIN_CHOOSE_HASH} data-testid="staff-login-back">
            ← Back
          </a>
          <a href={LOGIN_PATIENT_HASH} data-testid="staff-login-to-patient">
            Are you a patient? Patient sign-in →
          </a>
        </div>
      </form>
    </LoginFrame>
  );
}
