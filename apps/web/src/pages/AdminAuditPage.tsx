/**
 * AdminAuditPage — `/admin/audit`.
 *
 * Per PRD §2.4 admins do not see appointment audit (no role claims
 * carry the appointment-audit read). The back-end exposes
 * `GET /admin/audit` which returns a `rejected_per_role_policy`
 * envelope explaining what they can't see and where it lives.
 *
 * This page is the natural display surface for that envelope. It
 * keeps the audit nav link honest (it routes somewhere real)
 * while documenting the privacy boundary.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError, getAdminAudit, type AdminAuditEnvelope } from '../api/client';
import styles from './AdminAuditPage.module.css';

function ReloadIcon() {
  return '↻';
}

export function AdminAuditPage() {
  const [envelope, setEnvelope] = useState<AdminAuditEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const env = await getAdminAudit();
      setEnvelope(env);
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? `${err.status} ${err.code}`
          : 'network_error',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) {
    return (
      <div className={styles.status} role="status" aria-live="polite">
        Loading audit policy…
      </div>
    );
  }

  if (error || !envelope) {
    return (
      <div
        className={`${styles.status} ${styles['status--error']}`}
        role="alert"
      >
        Could not load audit policy: {error ?? 'unknown_error'}
        <div className={styles['status__retry']}>
          <button
            type="button"
            className={styles['btn-secondary']}
            onClick={() => void refresh()}
          >
            <ReloadIcon /> Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.crumb}>
        <span>Admin</span>
        <span className={styles['crumb__sep']}>›</span>
        <span className={styles['crumb__here']}>Audit log</span>
      </div>

      <div className={styles['page-header']}>
        <div className={styles['page-header__title']}>
          <h1>Audit log</h1>
          <div className={styles['page-header__sub']}>
            Why you don&apos;t see appointment audit rows here.
          </div>
        </div>
        <div className={styles['page-header__actions']}>
          <button
            type="button"
            className={styles['btn-secondary']}
            onClick={() => void refresh()}
          >
            <ReloadIcon /> Refresh
          </button>
        </div>
      </div>

      <section className={`${styles.card} ${styles['card--policy']}`}>
        <header className={styles['card-head']}>
          <div className={styles['card-head__icon']} aria-hidden="true">
            ⓘ
          </div>
          <div className={styles['card-head__title']}>Audit access policy</div>
          <div className={styles['card-head__hint']}>
            Per PRD §2.4 (Privacy boundaries).
          </div>
        </header>
        <div className={styles['card-body']}>
          <div className={styles['card-row']}>
            <div className={styles['card-row__label']}>Appointments audit</div>
            <div className={styles['card-row__value']}>
              <span
                className={`${styles.pill} ${styles['pill--rejected']}`}
              >
                ✕ {envelope.appointments_audit_reads}
              </span>
            </div>
          </div>
          <div className={styles['card-row']}>
            <div className={styles['card-row__label']}>Reason</div>
            <div className={styles['card-row__value']}>{envelope.reason}</div>
          </div>
          <div className={styles['card-row']}>
            <div className={styles['card-row__label']}>Reference</div>
            <div className={styles['card-row__value']}>
              <code>{envelope.reference}</code>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <header className={styles['card-head']}>
          <div className={styles['card-head__title']}>
            Where appointment audit lives
          </div>
          <div className={styles['card-head__hint']}>
            The doctor and patient see their own appointment audit on
            each surface.
          </div>
        </header>
        <div className={styles['card-body']}>
          <div className={styles['card-row']}>
            <div className={styles['card-row__label']}>Doctor endpoint</div>
            <div className={styles['card-row__value']}>
              <code>{envelope.doctor_endpoint}</code>
            </div>
          </div>
          <div className={styles['card-row']}>
            <div className={styles['card-row__label']}>
              Receptionist endpoint
            </div>
            <div className={styles['card-row__value']}>
              <code>{envelope.receptionist_endpoint}</code>
            </div>
          </div>
          <div className={styles['card-row']}>
            <div className={styles['card-row__label']}>Future work</div>
            <div className={styles['card-row__value']}>
              {envelope.future_work}
            </div>
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <header className={styles['card-head']}>
          <div className={styles['card-head__title']}>
            Configuration change history
          </div>
          <div className={styles['card-head__hint']}>
            Not yet captured. The audit table today covers appointments
            only.
          </div>
        </header>
        <div className={styles['card-body']}>
          <ul className={styles.list}>
            <li>
              <strong>Branch</strong> create / patch / status change
              (active ⇄ inactive).
            </li>
            <li>
              <strong>Appointment type</strong> create / patch.
            </li>
            <li>
              <strong>Doctor</strong> create / patch / branch
              assignment / status change.
            </li>
            <li>
              <strong>Receptionist</strong> create / patch / branch
              assignment / status change.
            </li>
          </ul>
          <div className={styles['card-row']}>
            <div className={styles['card-row__label']}>Status</div>
            <div className={styles['card-row__value']}>
              <span
                className={`${styles.pill} ${styles['pill--rejected']}`}
              >
                ✕ Not implemented
              </span>
            </div>
          </div>
          <div className={styles['card-row']}>
            <div className={styles['card-row__label']}>Planned route</div>
            <div className={styles['card-row__value']}>
              <code>GET /admin/configuration-audit</code>
            </div>
          </div>
          <div className={styles['card-row']}>
            <div className={styles['card-row__label']}>Note</div>
            <div className={styles['card-row__value']}>
              {envelope.future_work}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}