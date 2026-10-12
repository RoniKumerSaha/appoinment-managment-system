/**
 * DoctorResolutionSaved — E6-S2 success screen (mock 37).
 *
 * The success modal shown once a single doctor move has been confirmed.
 * Pixel-perfect port of mockup 37: success icon + summary card
 * with the moved row + a small audit-log peek. The full audit
 * drawer lives in E7-S2 (#17); this page only echoes the most
 * recent move row.
 */
import type { ResolvedInfo } from './DoctorResolve';
import {
  formatDateInTz,
  formatTimeInTz,
} from './doctor-utils';
import './DoctorResolutionSaved.css';

export interface SavedAuditEvent {
  /** ISO timestamp. */
  at: string;
  /** Short label shown in the audit block. */
  label: string;
  /** Tone for the small pill: 'create' | 'cancel' | 'resolve' | 'config'. */
  tone: 'create' | 'cancel' | 'resolve' | 'config';
}

interface DoctorResolutionSavedProps {
  info: ResolvedInfo;
  remaining: number;
  onClose: () => void;
  onResolveAnother: () => void;
  /**
   * Mockup 37 — the mock shows a 4-row audit block below the
   * resolution summary. Optional: when provided, render it; when
   * omitted, fall back to the principle-note copy.
   */
  recent?: SavedAuditEvent[];
  /** Optional: open the full audit drawer (E7-S2). */
  onOpenAuditDrawer?: () => void;
}

export function DoctorResolutionSaved({
  info,
  remaining,
  onClose,
  onResolveAnother,
  recent,
  onOpenAuditDrawer,
}: DoctorResolutionSavedProps) {
  // The summary card uses the destination branch's tz; we don't
  // store it on the resolve info, so we render in UTC for the
  // peek row. Future hardening can carry the tz in the info.
  const tzGuess = 'UTC';
  const toStart = formatTimeInTz(info.toStart, tzGuess);
  const toDate = formatDateInTz(info.toStart, tzGuess);
  const fromDate = formatDateInTz(info.fromStart, tzGuess);

  return (
    <div
      className="doc-saved__backdrop"
      role="dialog"
      aria-modal="true"
      data-testid="doc-saved-modal"
    >
      <div className="doc-saved__modal" data-testid="doc-saved-frame">
        <div className="doc-saved__success-head" data-testid="doc-saved-success-head">
          <div className="doc-saved__success-icon" aria-hidden="true">
            ✓
          </div>
          <h1 className="doc-saved__success-title" data-testid="doc-saved-title">
            {remaining > 0
              ? `1 of ${remaining + 1} resolved.`
              : 'All affected appointments resolved.'}
          </h1>
          <p className="doc-saved__success-sub">
            The patient will see the change at their next visit. No surprises.
          </p>
        </div>

        <div className="doc-saved__summary" data-testid="doc-saved-summary">
          <div className="doc-saved__summary-head">
            <div className="doc-saved__summary-ic" aria-hidden="true">
              📅
            </div>
            <h2 className="doc-saved__summary-title">Resolution summary</h2>
            <span className="doc-saved__summary-meta">just now</span>
          </div>
          <div className="doc-saved__row" data-testid="doc-saved-summary-row">
            <div className="doc-saved__time">
              {toDate}
              <div className="doc-saved__time-range">{toStart}</div>
            </div>
            <div className="doc-saved__body">
              <div className="doc-saved__name">
                Patient ···{info.patient_phone.slice(-4)}
              </div>
              <div className="doc-saved__action">
                Moved from {fromDate}
                <span className="doc-saved__arrow">→</span>
                {toStart} at {info.branchName}
              </div>
            </div>
            <span className="doc-saved__pill doc-saved__pill--moved">
              ✓ Moved
            </span>
          </div>
        </div>

        <div className="doc-saved__actions" data-testid="doc-saved-actions">
          <button
            type="button"
            className="doc-saved__btn-secondary"
            data-testid="doc-saved-back-btn"
            onClick={onClose}
          >
            ← Back to queue
          </button>
          {remaining > 0 && (
            <button
              type="button"
              className="doc-saved__btn-primary"
              data-testid="doc-saved-resolve-next-btn"
              onClick={onResolveAnother}
            >
              Resolve next
            </button>
          )}
        </div>

        {recent && recent.length > 0 ? (
          <div className="doc-saved__audit" data-testid="doc-saved-audit">
            <div className="doc-saved__audit-head">
              <span aria-hidden="true">🛡</span>
              <span>Audit log</span>
            </div>
            <ul className="doc-saved__audit-list">
              {recent.map((ev, i) => (
                <li key={i} className="doc-saved__audit-row" data-testid={`doc-saved-audit-row-${i}`}>
                  <span
                    className={`doc-saved__pill doc-saved__pill--${ev.tone}`}
                  >
                    {ev.tone === 'create'
                      ? 'CREATE'
                      : ev.tone === 'cancel'
                        ? 'CANCEL'
                        : ev.tone === 'resolve'
                          ? 'RESOLVE'
                          : 'CONFIG'}
                  </span>
                  <span className="doc-saved__audit-time">
                    {formatTimeInTz(ev.at, 'UTC')}
                  </span>
                  <span className="doc-saved__audit-label">{ev.label}</span>
                </li>
              ))}
            </ul>
            {onOpenAuditDrawer && (
              <button
                type="button"
                className="doc-saved__audit-link"
                data-testid="doc-saved-audit-link-btn"
                onClick={onOpenAuditDrawer}
              >
                View all {recent.length} event{recent.length === 1 ? '' : 's'} in audit drawer →
              </button>
            )}
          </div>
        ) : (
          <div className="doc-saved__note" data-testid="doc-saved-note">
            <span aria-hidden="true">🛡</span>
            <div>
              Every action here is logged. The full audit trail is in the
              audit drawer (E7-S2).
            </div>
          </div>
        )}
      </div>
    </div>
  );
}