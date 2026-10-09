/**
 * verify-public-dtos.ts — confirm the new fields surface in the public
 * catalog after the 0019 + DTO change. Mint a patient JWT via signClaim
 * (same approach as e2e-api-smoke.ts) and call each endpoint.
 *
 * Run: `pnpm exec --filter @clinic/api tsx scripts/verify-public-dtos.ts`
 */
import './_load-env.js';
import { signClaim } from '../src/auth/jwt.js';

const BASE = process.env['API_BASE_URL'] ?? 'http://localhost:3001';
const PHONE = '+15559990001';

function mintPatientToken(): string {
  // Patient claim: role=patient, scope=self, branch_ids=[] (patients
  // have no branch scope). signClaim strips extras and signs the
  // canonical payload. The /public/* routes only require any
  // authenticated caller; this is the cheapest valid claim.
  return signClaim({
    role: 'patient',
    sub: `patient:${PHONE}`,
    branch_ids: [],
    scope: 'self',
  });
}

async function getJson<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path} -> ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  const token = mintPatientToken();
  console.log('=== /public/doctors ===');
  const doctors = await getJson<{ doctors: Array<Record<string, unknown>> }>(
    '/public/doctors',
    token,
  );
  console.log(JSON.stringify(doctors, null, 2));

  const firstDocId = doctors.doctors[0]?.id as string;
  console.log(`\n=== /public/branches?doctor_id=${firstDocId} ===`);
  const branches = await getJson<{ branches: Array<Record<string, unknown>> }>(
    `/public/branches?doctor_id=${firstDocId}`,
    token,
  );
  console.log(JSON.stringify(branches, null, 2));

  console.log('\n=== /public/appointment-types ===');
  const types = await getJson<{ appointment_types: Array<Record<string, unknown>> }>(
    '/public/appointment-types',
    token,
  );
  console.log(JSON.stringify(types, null, 2));
}
main().catch((err) => {
  console.error('verify-public-dtos: fatal', err);
  process.exit(1);
});
