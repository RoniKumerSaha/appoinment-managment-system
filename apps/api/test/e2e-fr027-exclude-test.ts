import pkg from 'pg';
const { Client } = pkg;

const c = new Client({ connectionString: process.env['DATABASE_URL']! });
await c.connect();

// For each future Scheduled for Dr. East Lead, run the FR-027 check
// with and without an "exclude self" predicate. If they diverge, the
// doctor-move route is false-failing FR-027 on the moving row.
const r = await c.query<{
  id: string; patient_phone: string; start_datetime: Date;
}>(`SELECT id::text, patient_phone, start_datetime
      FROM appointment
     WHERE doctor_id = (SELECT id FROM doctor WHERE full_name = 'Dr. East Lead' LIMIT 1)
       AND status = 'Scheduled' AND start_datetime > now()
     ORDER BY start_datetime ASC LIMIT 5`);

console.log('Per appointment, FR-027 SQL:');
console.log('  including_self  excluding_self  verdict');
for (const a of r.rows) {
  const inc = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM appointment
      WHERE patient_phone = $1
        AND doctor_id = (SELECT id FROM doctor WHERE full_name = 'Dr. East Lead' LIMIT 1)
        AND status = 'Scheduled' AND start_datetime > now()`,
    [a.patient_phone],
  );
  const exc = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM appointment
      WHERE patient_phone = $1
        AND doctor_id = (SELECT id FROM doctor WHERE full_name = 'Dr. East Lead' LIMIT 1)
        AND status = 'Scheduled' AND start_datetime > now()
        AND id <> $2`,
    [a.patient_phone, a.id],
  );
  const verdict = inc.rows[0]!.n === exc.rows[0]!.n ? 'agree' : 'DIVERGE — bug';
  console.log(`  ${a.id.slice(0,8)} ${inc.rows[0]!.n}              ${exc.rows[0]!.n}              ${verdict}`);
}
await c.end();