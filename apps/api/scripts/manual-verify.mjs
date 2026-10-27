/**
 * manual-verify.mjs — smoke-test the LIVE dev API for the gaps the
 * user reported ("can't create appointment type", "can edit branch
 * address", ...). Read-only apart from the two writes under test.
 *
 * Usage: node scripts/manual-verify.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://localhost:3001';

let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: json };
}

console.log(`\n=== Live API smoke test against ${BASE} ===\n`);

// ── Health ──────────────────────────────────────────────────────
console.log('health');
const health = await call('/healthz');
check('GET /healthz → 200', health.status === 200, JSON.stringify(health.body));
const ready = await call('/readyz');
check('GET /readyz → 200 (db reachable)', ready.status === 200, JSON.stringify(ready.body));

// ── Admin login ─────────────────────────────────────────────────
console.log('\nauth');
const login = await call('/auth/login/staff', {
  method: 'POST',
  body: { role: 'admin', email: 'admin-main@clinic.local' },
});
check('POST /auth/login/staff (admin) → 200', login.status === 200, JSON.stringify(login.body).slice(0, 120));
const token = login.body?.token;
if (!token) {
  console.log('\nCannot continue without an admin token.');
  process.exit(1);
}

// ── P0-1: create appointment type (was HTTP 500) ────────────────
console.log('\nP0-1  create appointment type (was 500)');
const typeName = `Manual Verify ${Date.now()}`;
const createType = await call('/admin/appointment-types', {
  method: 'POST',
  token,
  // The exact body the web form sends (apps/web/src/api/client.ts).
  body: { name: typeName, duration_minutes: 30 },
});
check(
  'POST /admin/appointment-types → 201 (not 500)',
  createType.status === 201,
  `HTTP ${createType.status} ${JSON.stringify(createType.body).slice(0, 160)}`,
);
const createdTypeId = createType.body?.id;

// ── P0-1b: the API process must survive the write ───────────────
console.log('\nP0-1b  api process survived the write');
const healthAfter = await call('/healthz');
check('GET /healthz still 200 after the write', healthAfter.status === 200);

// ── P0-2: edit branch address (was HTTP 400 unknown_field) ──────
console.log('\nP0-2  edit branch address (was 400 unknown_field)');
const branches = await call('/admin/branches', { token });
const branchList = branches.body?.branches ?? branches.body ?? [];
const branch = Array.isArray(branchList) ? branchList[0] : null;
if (branch === undefined || branch === null) {
  check('GET /admin/branches → a branch to edit', false, JSON.stringify(branches.body).slice(0, 200));
} else {
  const patch = await call(`/admin/branches/${branch.id}`, {
    method: 'PATCH',
    token,
    body: { address: '221B Baker Street, London' },
  });
  check(
    'PATCH /admin/branches/:id {address} → 200 (not 400 unknown_field)',
    patch.status === 200,
    `HTTP ${patch.status} ${JSON.stringify(patch.body).slice(0, 160)}`,
  );
  const readBack = await call(`/admin/branches/${branch.id}`, { token });
  const addr =
    readBack.body?.branch?.address ?? readBack.body?.address ?? readBack.body?.data?.address;
  check('the address persisted', addr === '221B Baker Street, London', String(addr));
}

// ── New routes are mounted ──────────────────────────────────────
console.log('\nnew routes');
for (const [label, path] of [
  ['GET /patient/recurring-series', '/patient/recurring-series'],
  ['GET /reception/branch/schedule', '/reception/branch/schedule'],
  ['GET /doctor/recurring-series/:id', '/doctor/recurring-series/11111111-1111-4111-8111-111111111111'],
]) {
  const res = await call(path);
  check(`${label} → 401 (mounted, auth-gated)`, res.status === 401, `HTTP ${res.status}`);
}

// ── Role gates ──────────────────────────────────────────────────
console.log('\nrole gates');
const patientLogin = await call('/patient/otp/verify-now', {
  method: 'POST',
  body: { phone: '+15550000001', code: '123456' },
});
if (patientLogin.status === 200 && patientLogin.body?.token) {
  const pToken = patientLogin.body.token;
  const asDoctor = await call('/doctor/recurring-series/11111111-1111-4111-8111-111111111111', {
    token: pToken,
  });
  check('patient → GET /doctor/recurring-series → 403', asDoctor.status === 403, `HTTP ${asDoctor.status}`);
  const own = await call('/patient/recurring-series', { token: pToken });
  check('patient → GET /patient/recurring-series → 200', own.status === 200, `HTTP ${own.status}`);
  check(
    'the response carries a `series` array',
    Array.isArray(own.body?.series),
    JSON.stringify(own.body).slice(0, 120),
  );
} else {
  console.log(`  SKIP  patient OTP login did not succeed (HTTP ${patientLogin.status})`);
}

// ── Cleanup the type we created ─────────────────────────────────
// Types are never hard-deleted (appointments reference them); the
// lifecycle is deactivate via PATCH is_active=false.
if (createdTypeId) {
  console.log('\ncleanup');
  const deactivate = await call(`/admin/appointment-types/${createdTypeId}`, {
    method: 'PATCH',
    token,
    body: { is_active: false },
  });
  check(
    'PATCH /admin/appointment-types/:id {is_active:false} → 200',
    deactivate.status === 200,
    `HTTP ${deactivate.status} ${JSON.stringify(deactivate.body).slice(0, 120)}`,
  );
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
