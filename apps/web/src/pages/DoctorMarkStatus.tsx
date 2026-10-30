/**
 * DoctorMarkStatus — the doctor's wrapper around the shared
 * `StaffMarkStatus` modal.
 *
 * The modal itself was generalised from this component when the
 * receptionist gained the same action (the API has always allowed
 * `POST /appointments/:id/mark-status` for both staff roles — the
 * receptionist simply had no entry point). This file stays as the
 * doctor's caller so the doctor's pages do not have to pass the
 * role/crumb props at every call site.
 */
import type { ReactNode } from 'react';
import {
  StaffMarkStatus,
  type StaffMarkTarget,
} from './StaffMarkStatus';

export type DoctorMarkTarget = StaffMarkTarget;

export interface DoctorMarkStatusProps {
  appointment: DoctorMarkTarget;
  onCancel: () => void;
  onMarked: (status: 'Completed' | 'No-show') => Promise<void> | void;
  onStale?: () => void;
  describeError: (err: unknown) => string;
  /** Overrides the default breadcrumb ("Affected queue → …"). */
  crumb?: string;
}

export function DoctorMarkStatus({
  appointment,
  onCancel,
  onMarked,
  onStale,
  describeError,
  crumb,
}: DoctorMarkStatusProps): ReactNode {
  return (
    <StaffMarkStatus
      appointment={appointment}
      onCancel={onCancel}
      onMarked={onMarked}
      onStale={onStale}
      describeError={describeError}
      role="doctor"
      crumb={crumb ?? `Affected queue → ${appointment.patientLabel} → Mark status`}
    />
  );
}
