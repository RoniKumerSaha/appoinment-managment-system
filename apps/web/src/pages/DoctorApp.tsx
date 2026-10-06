/**
 * DoctorApp — top-level doctor container (W59 deferral).
 *
 * Mirrors the receptionist and patient internal-router pattern.
 * Today the doctor surface exposes the E6-S2 affected queue +
 * resolve flow, plus the E7-S2 audit drawer (mock 30). Future
 * stories add weekly schedule (mock 09) and the today queue
 * (mock 12). The view machine is the natural place to fold those
 * in.
 *
 *  - 'affected' → <DoctorAffected /> with the audit drawer
 *                 overlaid when an "View audit log" affordance
 *                 is triggered.
 *
 * No tests in this pass (per user instruction).
 */
import { useCallback, useState } from 'react';
import { DoctorAffected } from './DoctorAffected';
import { DoctorAuditDrawer } from './DoctorAuditDrawer';

interface AuditTarget {
  appointmentId: string;
  appointmentLabel: string;
  branchTz: string;
}

interface DoctorAppProps {
  initialView?: 'affected';
}

export function DoctorApp({ initialView }: DoctorAppProps) {
  const currentView: 'affected' = initialView ?? 'affected';
  const [auditTarget, setAuditTarget] = useState<AuditTarget | null>(null);

  const openAudit = useCallback((t: AuditTarget): void => {
    setAuditTarget(t);
  }, []);

  const closeAudit = useCallback((): void => {
    setAuditTarget(null);
  }, []);

  if (currentView === 'affected') {
    return (
      <>
        <DoctorAffected onOpenAudit={openAudit} />
        {auditTarget !== null && (
          <DoctorAuditDrawer
            appointmentId={auditTarget.appointmentId}
            appointmentLabel={auditTarget.appointmentLabel}
            branchTz={auditTarget.branchTz}
            onClose={closeAudit}
          />
        )}
      </>
    );
  }

  return <DoctorAffected onOpenAudit={openAudit} />;
}