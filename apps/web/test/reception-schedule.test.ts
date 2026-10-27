/**
 * reception-schedule.test.ts — the receptionist's day calendar.
 *
 * Two things are pinned here:
 *
 *  1. The client function must talk to the route the API actually
 *     exposes (`GET /reception/branch/schedule`) and carry only the
 *     optional filters the route accepts.
 *
 *  2. The calendar merge must be a union of the OPEN half
 *     (`GET /availability`) and the BOOKED half (the schedule
 *     route), sorted by UTC instant, with a booked slot carrying the
 *     patient's first-name initial only (F-15).
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

const { getReceptionSchedule } = await import('../src/api/client.js');
const { addDays, daysInRange, mergeDaySlots } = await import(
  '../src/pages/reception-schedule.js'
);

interface Captured {
  url: string;
  method: string;
}

function stubFetch(
  status: number,
  body: unknown,
): { captured: Captured; restore: () => void } {
  const captured: Captured = { url: '', method: '' };
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    captured.url = String(url);
    captured.method = init.method ?? 'GET';
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

const SCHEDULE = {
  date: '2026-10-26',
  branch: { id: 'branch-1', name: 'East Branch', tz: 'America/New_York' },
  booked: [
    {
      id: 'appt-1',
      doctor_id: 'doctor-1',
      doctor_name: 'Dr. East Lead',
      appointment_type_id: 'type-1',
      appointment_type_name: 'General Consultation',
      patient_initial: 'L',
      start_datetime: '2026-10-26T14:00:00.000Z',
      end_datetime: '2026-10-26T14:30:00.000Z',
    },
  ],
};

test('getReceptionSchedule GETs /reception/branch/schedule with no params', async () => {
  const { captured, restore } = stubFetch(200, SCHEDULE);
  try {
    const res = await getReceptionSchedule();
    assert.equal(captured.url, '/reception/branch/schedule');
    assert.equal(captured.method, 'GET');
    assert.equal(res.date, SCHEDULE.date);
    assert.equal(res.branch.tz, 'America/New_York');
    assert.equal(res.booked.length, 1);
    assert.equal(res.booked[0]?.patient_initial, 'L');
  } finally {
    restore();
  }
});

test('getReceptionSchedule forwards the date and doctor_id filters', async () => {
  const { captured, restore } = stubFetch(200, SCHEDULE);
  try {
    await getReceptionSchedule({
      date: '2026-10-26',
      doctor_id: 'doctor-1',
    });
    assert.equal(
      captured.url,
      '/reception/branch/schedule?date=2026-10-26&doctor_id=doctor-1',
    );
  } finally {
    restore();
  }
});

test('the booked payload carries no patient name or phone (F-15)', async () => {
  const { restore } = stubFetch(200, SCHEDULE);
  try {
    const res = await getReceptionSchedule();
    const row = res.booked[0]!;
    assert.equal(row.patient_initial, 'L');
    assert.equal(
      (row as unknown as { patient_name?: string }).patient_name,
      undefined,
    );
    assert.equal(
      (row as unknown as { patient_phone?: string }).patient_phone,
      undefined,
    );
  } finally {
    restore();
  }
});

test('mergeDaySlots unions the open and booked halves in start order', () => {
  const slots = mergeDaySlots(
    ['2026-10-26T13:00:00.000Z', '2026-10-26T15:00:00.000Z'],
    SCHEDULE.booked,
    30,
  );
  assert.equal(slots.length, 3);
  assert.deepEqual(
    slots.map((s) => s.start),
    [
      '2026-10-26T13:00:00.000Z',
      '2026-10-26T14:00:00.000Z',
      '2026-10-26T15:00:00.000Z',
    ],
  );
  assert.deepEqual(
    slots.map((s) => s.state),
    ['open', 'booked', 'open'],
  );
});

test('an open slot is closed at the type duration', () => {
  const slots = mergeDaySlots(['2026-10-26T13:00:00.000Z'], [], 45);
  assert.equal(slots[0]?.end, '2026-10-26T13:45:00.000Z');
});

test('a booked slot keeps the server end instant and the initial', () => {
  const slots = mergeDaySlots([], SCHEDULE.booked, 30);
  assert.equal(slots.length, 1);
  assert.equal(slots[0]?.state, 'booked');
  assert.equal(slots[0]?.initial, 'L');
  assert.equal(slots[0]?.end, '2026-10-26T14:30:00.000Z');
});

test('mergeDaySlots handles an empty day', () => {
  assert.deepEqual(mergeDaySlots([], [], 30), []);
});

test('daysInRange lists the days inclusively', () => {
  assert.deepEqual(daysInRange('2026-10-26', '2026-10-29', 30), [
    '2026-10-26',
    '2026-10-27',
    '2026-10-28',
    '2026-10-29',
  ]);
});

test('daysInRange caps the fan-out at maxDays', () => {
  assert.equal(daysInRange('2026-10-26', '2027-10-29', 30).length, 30);
});

test('daysInRange returns nothing when the range is inverted', () => {
  assert.deepEqual(daysInRange('2026-10-29', '2026-10-26', 30), []);
});

test('addDays crosses a month boundary', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});
