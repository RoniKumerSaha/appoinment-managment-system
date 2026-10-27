/**
 * api-error-body.test.ts — the API client must surface the failed
 * response's BODY, not just its status + error code.
 *
 * The 409 from `PATCH /admin/branches/:id/hours` carries an `impact`
 * object (affected-appointment count, affected doctors, the
 * acknowledgement flag). The branch-hours screen renders that payload,
 * so the transport has to hand it through. Before this, `request()`
 * parsed the body to read `error` and then threw it away, so the
 * conflict screen could never show what the server told it.
 *
 * The client reads `localStorage` and calls `fetch`; both are stubbed
 * here so the test runs in plain Node with no browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The client module touches `localStorage` at call time (not at import
// time), so a minimal stub is enough for the transport to work.
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

const { ApiError, patchBranchHours } = await import('../src/api/client.js');

/** Install a `fetch` stub that answers the next request with `status`
 *  and `body`. Returns a restore function. */
function stubFetch(status: number, body: unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test('a 409 with an impact payload surfaces the impact on the ApiError', async () => {
  const impact = {
    count_affected: 3,
    affected_doctors: [
      { doctor_id: 'd1', doctor_name: 'Dr. East Lead', count: 2 },
    ],
    requires_doctor_acknowledgement: true,
  };
  const restore = stubFetch(409, { error: 'appointments_outside_hours', impact });

  try {
    await assert.rejects(
      () =>
        patchBranchHours(
          '00000000-0000-0000-0000-000000000000',
          { hours: [] },
          false,
        ),
      (err: unknown) => {
        assert.ok(err instanceof ApiError, 'expected an ApiError');
        assert.equal(err.status, 409);
        assert.equal(err.code, 'appointments_outside_hours');
        // The payload the conflict screen needs.
        assert.deepEqual(err.body['impact'], impact);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('a 400 unknown_field surfaces the offending field names', async () => {
  const restore = stubFetch(400, {
    error: 'unknown_field',
    fields: ['clinic_id'],
  });

  try {
    await assert.rejects(
      () =>
        patchBranchHours(
          '00000000-0000-0000-0000-000000000000',
          { hours: [] },
          false,
        ),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.code, 'unknown_field');
        assert.deepEqual(err.body['fields'], ['clinic_id']);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('a non-JSON error body still yields a usable ApiError', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('<html>gateway error</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    })) as typeof fetch;

  try {
    await assert.rejects(
      () =>
        patchBranchHours(
          '00000000-0000-0000-0000-000000000000',
          { hours: [] },
          false,
        ),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 502);
        // No `error` field in the body → the generic code.
        assert.equal(err.code, 'unknown_error');
        assert.deepEqual(err.body, {});
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});
