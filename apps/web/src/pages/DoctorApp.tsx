/**
 * DoctorApp — top-level doctor container (W59 deferral).
 *
 * Mirrors the receptionist and patient internal-router pattern.
 * Today the doctor surface exposes the E6-S2 affected queue +
 * resolve flow, plus the E7-S2 audit drawer (mock 30). The view
 * machine also surfaces the missing recurring screens:
 *   - 'preview'    → RecurringPreviewPage (mock 07)
 *   - 'confirm'    → RecurringConfirmPage (mock 23)
 *   - 'backout'    → RecurringBackOut     (mock 40)
 *
 * These are reachable via a `?page=preview|confirm|backout` query
 * parameter so the new screens can be demoed without rewriting
 * the existing affected-queue flow. The `affected` view remains
 * the default and is what the doctor sees on every day-to-day
 * login.
 *
 * No tests in this pass (per user instruction).
 */
import { useCallback, useEffect, useState } from 'react';
import { DoctorAffected } from './DoctorAffected';
import { DoctorAuditDrawer } from './DoctorAuditDrawer';
import { RecurringPreviewPage } from './RecurringPreviewPage';
import { RecurringConfirmPage } from './RecurringConfirmPage';
import { RecurringBackOut } from './RecurringBackOut';

interface AuditTarget {
  appointmentId: string;
  appointmentLabel: string;
  branchTz: string;
}

type DoctorView = 'affected' | 'preview' | 'confirm' | 'backout';

interface DoctorAppProps {
  initialView?: DoctorView;
}

function readPageParam(): DoctorView | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('page');
  if (raw === 'preview' || raw === 'confirm' || raw === 'backout') return raw;
  return null;
}

export function DoctorApp({ initialView }: DoctorAppProps) {
  const [view, setView] = useState<DoctorView>(initialView ?? 'affected');
  const [auditTarget, setAuditTarget] = useState<AuditTarget | null>(null);

  // Honour a one-shot ?page=… deep-link so the new screens are
  // reachable from a URL paste.
  useEffect(() => {
    const v = readPageParam();
    if (v !== null) setView(v);
  }, []);

  const openAudit = useCallback((t: AuditTarget): void => {
    setAuditTarget(t);
  }, []);

  const closeAudit = useCallback((): void => {
    setAuditTarget(null);
  }, []);

  if (view === 'preview') {
    return <RecurringPreviewPage />;
  }
  if (view === 'confirm') {
    return <RecurringConfirmPage />;
  }
  if (view === 'backout') {
    return <RecurringBackOut />;
  }
  return (
    <div data-testid="doctor-app">
      <DoctorAffected onOpenAudit={openAudit} />
      {auditTarget !== null && (
        <DoctorAuditDrawer
          appointmentId={auditTarget.appointmentId}
          appointmentLabel={auditTarget.appointmentLabel}
          branchTz={auditTarget.branchTz}
          onClose={closeAudit}
        />
      )}
    </div>
  );
}