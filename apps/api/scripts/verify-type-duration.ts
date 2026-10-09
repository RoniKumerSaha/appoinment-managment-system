/**
 * verify-type-duration.ts — confirm PATCH /admin/appointment-types/:id
 * can now update duration_minutes (and combined edits work).
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

  // 1. Create a 30-min test type.
  const c1 = await fetch('http://localhost:3001/admin/appointment-types', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Duration Test',
      duration_minutes: 30,
      description: 'Initial 30-min description.',
    }),
  });
  const body1 = (await c1.json()) as {
    id: string;
    duration_minutes: number;
    description: string | null;
  };
  console.log(
    'CREATE:',
    c1.status,
    'duration=' + body1.duration_minutes,
    'description=' + JSON.stringify(body1.description),
  );

  // 2. PATCH only duration → 45.
  const c2 = await fetch(
    `http://localhost:3001/admin/appointment-types/${body1.id}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ duration_minutes: 45 }),
    },
  );
  const body2 = (await c2.json()) as {
    duration_minutes: number;
    description: string | null;
  };
  console.log(
    'PATCH DURATION ONLY:',
    c2.status,
    'duration=' + body2.duration_minutes,
    'description=' + JSON.stringify(body2.description),
  );

  // 3. PATCH duration + description together → 60 + new desc.
  const c3 = await fetch(
    `http://localhost:3001/admin/appointment-types/${body1.id}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        duration_minutes: 60,
        description: 'Now 60 min.',
      }),
    },
  );
  const body3 = (await c3.json()) as {
    duration_minutes: number;
    description: string | null;
  };
  console.log(
    'PATCH DURATION+DESC:',
    c3.status,
    'duration=' + body3.duration_minutes,
    'description=' + JSON.stringify(body3.description),
  );

  // 4. PATCH out-of-range duration → expect 400 invalid_duration_minutes.
  const c4 = await fetch(
    `http://localhost:3001/admin/appointment-types/${body1.id}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ duration_minutes: 1 }),
    },
  );
  const body4 = await c4.text();
  console.log('PATCH OOR (expect 400):', c4.status, body4);

  // 5. GET to confirm final state.
  const c5 = await fetch('http://localhost:3001/admin/appointment-types', {
    headers,
  });
  const body5 = (await c5.json()) as Array<{
    id: string;
    duration_minutes: number;
    description: string | null;
  }>;
  const mine = body5.find((t) => t.id === body1.id);
  console.log(
    'GET FINAL:',
    c5.status,
    'duration=' + mine?.duration_minutes,
    'description=' + JSON.stringify(mine?.description),
  );

  // Cleanup.
  const c6 = await fetch(
    `http://localhost:3001/admin/appointment-types/${body1.id}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ is_active: false }),
    },
  );
  console.log('CLEANUP:', c6.status);

  await closePool();
}
main().catch((err: unknown) => {
  console.error('verify-type-duration: fatal', err);
  process.exit(1);
});
