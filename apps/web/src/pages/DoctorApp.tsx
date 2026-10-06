/**
 * DoctorApp — top-level doctor container (W59 deferral).
 *
 * Mirrors the receptionist and patient internal-router pattern.
 * Today there's only one doctor surface (E6-S2 affected queue +
 * resolve flow); future stories add weekly schedule (mock 09),
 * audit drawer (mock 30), and the today queue (mock 12). The
 * view machine is the natural place to fold those in.
 *
 *  - 'affected' → <DoctorAffected /> (the only sub-page today).
 *
 * No tests in this pass (per user instruction).
 */
import { DoctorAffected } from './DoctorAffected';

type DoctorView = 'affected';

interface DoctorAppProps {
  initialView?: DoctorView;
}

export function DoctorApp({ initialView }: DoctorAppProps) {
  const currentView: DoctorView = initialView ?? 'affected';

  if (currentView === 'affected') {
    return <DoctorAffected />;
  }

  // Default fallback (no other views today).
  return <DoctorAffected />;
}