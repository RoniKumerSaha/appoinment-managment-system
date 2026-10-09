/**
 * verify-type-desc.ts — confirm the admin API can create + patch
 * appointment types WITH a description (post-0019).
 */
import './_load-env.js';
import { signClaim } from '../src/auth/jwt.js';
import { getPool, closePool } from '../src/db/pool.js';

async function main(): Promise<void> {
  const pool = await getPool();
  const c = await pool.connect();
  let branchId: string;
  try {
    const cr = await c.query<{ id: string }>(`SELECT id FROM clinic LIMIT 1`);
    const br = await c.query<{ id: string }>(
      `SELECT id FROM branch WHERE clinic_id = $1 LIMIT 1`,
      [cr.rows[0]!.id],
    );
    branchId = br.rows[0]!.id;
  } finally {
    c.release();
  }
  const token = signClaim({
    role: 'admin',
    sub: 'admin-main',
    branch_ids: [branchId],
    scope: 'clinic',
  });
  const headers = {
    'Content-Type': 'application/json',
    authorization: `Bearer ${token}`,
  };

  const c1 = await fetch('http://localhost:3001/admin/appointment-types', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Cardiology Consult',
      duration_minutes: 30,
      description: 'Standard 30-min cardio visit.',
    }),
  });
  const body1 = (await c1.json()) as {
    id: string;
    description: string | null;
  };
  console.log('CREATE:', c1.status, 'description=' + JSON.stringify(body1.description));

  const c2 = await fetch(
    `http://localhost:3001/admin/appointment-types/${body1.id}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ description: 'Updated description text.' }),
    },
  );
  const body2 = (await c2.json()) as { description: string | null };
  console.log('PATCH:', c2.status, 'description=' + JSON.stringify(body2.description));

  const c3 = await fetch('http://localhost:3001/admin/appointment-types', {
    headers,
  });
  const body3 = (await c3.json()) as Array<{
    id: string;
    description: string | null;
  }>;
  const mine = body3.find((t) => t.id === body1.id);
  console.log('GET:   ', c3.status, 'description=' + JSON.stringify(mine?.description));

  // Cleanup: deactivate.
  const c4 = await fetch(
    `http://localhost:3001/admin/appointment-types/${body1.id}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ is_active: false }),
    },
  );
  console.log('CLEANUP:', c4.status);

  await closePool();
}
main().catch((err: unknown) => {
  console.error('verify-type-desc: fatal', err);
  process.exit(1);
});
