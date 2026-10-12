import pkg from 'pg';
const { Client } = pkg;

const c = new Client({ connectionString: process.env['DATABASE_URL']! });
await c.connect();
const r = await c.query<{
  id: string; patient_phone: string; doctor_id: string; branch_id: string;
  status: string; start_datetime: Date; appointment_type_id: string;
}>(`SELECT id::text, patient_phone, doctor_id::text, branch_id::text, status,
            start_datetime, appointment_type_id::text
       FROM appointment
      WHERE doctor_id = (SELECT id FROM doctor WHERE full_name = 'Dr. East Lead' LIMIT 1)
        AND status = 'Scheduled' AND start_datetime > now()
      ORDER BY start_datetime ASC LIMIT 8`);
console.log('Future Scheduled for Dr. East Lead:');
for (const a of r.rows) {
  const sib = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM appointment
      WHERE patient_phone = $1 AND doctor_id = $2
        AND status = 'Scheduled' AND start_datetime > now()
        AND id <> $3`,
    [a.patient_phone, a.doctor_id, a.id],
  );
  console.log(`  ${a.id.slice(0,8)}  patient=${a.patient_phone}  start=${a.start_datetime.toISOString()}  sibling_future=${sib.rows[0]!.n}`);
}
await c.end();