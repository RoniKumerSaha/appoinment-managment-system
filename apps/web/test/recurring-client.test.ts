/**
 * recurring-client.test.ts — the web client's recurring functions
 * must talk to the routes the API actually exposes, with the body
 * shapes the API actually validates.
 *
 * `POST /recurring/preview` takes a `RecurringBody` (the exact key
 * set in `apps/api/src/routes/recurring-helpers.ts`) and answers
 * `{preview_id, branch, recurrence, will_create, skipped_with_reason}`.
 * `POST /recurring/confirm` takes `{preview_id}` and answers
 * `{series_id, created, skipped}`.
 *
 * The client is fetched with a stubbed `fetch`, so this runs in
 * plain Node with no browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    store.set(k, v);
  },
  removeItem: (k: string) => {
    store.delete(k);
  },
  clear: () => {
    store.clear();
  },
  key: () => null,
  length: 0,
} as unknown as Storage;

const {
  confirmRecurringSeries,
  previewRecurringSeries,
  getDoctorRecurringSeries,
  getPatientRecurringSeries,
  patientCancel,
  doctorCancel,
} = await import('../src/api/client.js');

interface Captured {
  url: string;
  method: string;
  body: unknown;
}

/** Install a `fetch` stub that records the request and answers with
 *  `status` + `body`. Returns the capture and a restore function. */
function stubFetch(
  status: number,
  body: unknown,
): { captured: Captured; restore: () => void } {
  const captured: Captured = { url: '', method: '', body: undefined };
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    captured.url = String(url);
    captured.method = init.method ?? 'GET';
    captured.body =
      typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return {
    captured,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** The exact key set `validateRecurringBody` accepts. A body with
 *  any extra key is rejected with `unknown_field`. */
const ALLOWED_KEYS = new Set([
  'doctor_id',
  'branch_id',
  'appointment_type_id',
  'patient_phone',
  'patient_first_name',
  'recurrence_kind',
  'recurrence_interval_days',
  'start_date',
  'time_of_day',
  'duration_minutes',
  'occurrences_or_until_date',
]);

const SERIES_INPUT = {
  doctor_id: '11111111-1111-1111-1111-111111111111',
  branch_id: '22222222-2222-2222-2222-222222222222',
  appointment_type_id: '33333333-3333-3333-3333-333333333333',
  patient_phone: '+966512345678',
  patient_first_name: 'Fatima',
  recurrence_kind: 'weekly' as const,
  recurrence_interval_days: 7,
  start_date: '2026-11-04',
  time_of_day: '09:00',
  duration_minutes: 30,
  occurrences_or_until_date: 6,
};

test('previewRecurringSeries POSTs the series body to /recurring/preview', async () => {
  const preview = {
    preview_id: '44444444-4444-4444-4444-444444444444',
    branch: { id: SERIES_INPUT.branch_id, tz: 'Asia/Riyadh' },
    recurrence: {
      kind: 'weekly',
      interval_days: 7,
      start_date: '2026-11-04',
      time_of_day: '09:00',
      duration_minutes: 30,
    },
    will_create: [],
    skipped_with_reason: [],
  };
  const { captured, restore } = stubFetch(200, preview);
  try {
    const res = await previewRecurringSeries(SERIES_INPUT);
    assert.equal(captured.url, '/recurring/preview');
    assert.equal(captured.method, 'POST');
    // Every key the client sends is one the server accepts.
    for (const k of Object.keys(captured.body as object)) {
      assert.ok(
        ALLOWED_KEYS.has(k),
        `client sent a key the server rejects: ${k}`,
      );
    }
    assert.deepEqual(captured.body, SERIES_INPUT);
    assert.equal(res.preview_id, preview.preview_id);
    assert.equal(res.branch.tz, 'Asia/Riyadh');
  } finally {
    restore();
  }
});

test('confirmRecurringSeries POSTs the preview_id to /recurring/confirm', async () => {
  const result = {
    series_id: '55555555-5555-5555-5555-555555555555',
    created: [],
    skipped: [],
  };
  const { captured, restore } = stubFetch(201, result);
  try {
    const res = await confirmRecurringSeries(
      '44444444-4444-4444-4444-444444444444',
    );
    assert.equal(captured.url, '/recurring/confirm');
    assert.equal(captured.method, 'POST');
    assert.deepEqual(captured.body, {
      preview_id: '44444444-4444-4444-4444-444444444444',
    });
    assert.equal(res.series_id, result.series_id);
  } finally {
    restore();
  }
});

test('a rejected preview surfaces the server error code', async () => {
  const { restore } = stubFetch(400, { error: 'patient_not_found' });
  try {
    await assert.rejects(
      () => previewRecurringSeries(SERIES_INPUT),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as { code?: string }).code, 'patient_not_found');
        return true;
      },
    );
  } finally {
    restore();
  }
});

// ─── E6-S4 — patient per-occurrence cancel (mock 33) ────────────

test('getPatientRecurringSeries GETs /patient/recurring-series', async () => {
  const { captured, restore } = stubFetch(200, { series: [] });
  try {
    const res = await getPatientRecurringSeries();
    assert.equal(captured.url, '/patient/recurring-series');
    assert.equal(captured.method, 'GET');
    assert.deepEqual(res.series, []);
  } finally {
    restore();
  }
});

test('patientCancel POSTs to /patient/appointments/:id/cancel', async () => {
  const { captured, restore } = stubFetch(200, {
    appointment: { id: 'abc', status: 'Cancelled' },
  });
  try {
    await patientCancel('abc');
    assert.equal(captured.url, '/patient/appointments/abc/cancel');
    assert.equal(captured.method, 'POST');
  } finally {
    restore();
  }
});

// ─── mock 40 — doctor back-out ─────────────────────────────────

test('getDoctorRecurringSeries GETs /doctor/recurring-series/:id', async () => {
  const seriesId = '66666666-6666-4666-8666-666666666666';
  const { captured, restore } = stubFetch(200, {
    series: {
      series_id: seriesId,
      occurrence_count: 2,
      scheduled_count: 2,
      cancelled_count: 0,
      completed_count: 0,
      occurrences: [],
    },
    audit: [],
  });
  try {
    const res = await getDoctorRecurringSeries(seriesId);
    assert.equal(captured.url, `/doctor/recurring-series/${seriesId}`);
    assert.equal(captured.method, 'GET');
    assert.equal(res.series.series_id, seriesId);
  } finally {
    restore();
  }
});

test('doctorCancel POSTs the reason to /appointments/:id/cancel', async () => {
  const { captured, restore } = stubFetch(200, {
    appointment: { id: 'occ-1', status: 'Cancelled' },
  });
  try {
    await doctorCancel('occ-1', { reason: 'doctor unavailable' });
    assert.equal(captured.url, '/appointments/occ-1/cancel');
    assert.equal(captured.method, 'POST');
    // FR-035 — a reason is mandatory, so the client always sends one.
    assert.deepEqual(captured.body, { reason: 'doctor unavailable' });
  } finally {
    restore();
  }
});
