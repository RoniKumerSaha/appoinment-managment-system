/**
 * SmsOtpService — the OTP subsystem's brain.
 *
 * Two entry points:
 *   - `send(phone)`     — generate + persist + dispatch a 6-digit OTP
 *   - `verify(phone, code)` — compare + commit
 *
 * The service is the SOLE writer to `otp_verification`. Routes call this
 * class; nothing else inserts/updates/deletes rows in that table. (Test
 * helpers may create fixtures but never with the live `code_hash` column.)
 *
 * Transactional contract:
 *   - `send()` runs `BEGIN; DELETE expired; check cooldown/locked; INSERT;
 *     provider.send(); COMMIT`. If the provider throws, the transaction
 *     is rolled back and no orphan `otp_verification` row remains. The
 *     caller surfaces 502 and the user retries. This is the AC-22
 *     contract — provider failure is atomic with the DB write.
 *
 *   - `verify()` runs `BEGIN; SELECT FOR UPDATE; compare hash; on success
 *     DELETE row + COMMIT + mint JWT; on failure UPDATE attempts (and
 *     locked_until if threshold hit) + COMMIT + throw`. The `FOR UPDATE`
 *     lock prevents two parallel verifies from both decrementing attempts.
 *
 * `code_hash` is `pgcrypto.digest(code, 'sha256')` — 64-char hex. We do
 * NOT compute the hash in Node because then we'd be computing the same
 * hash on every verify (defeating timing-safe comparison at the SQL level).
 * Doing it in SQL keeps the contract symmetric: insert-side and verify-side
 * both use the database's pgcrypto.
 */
import type pg from 'pg';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { signClaim, verifyToken } from '../auth/jwt.js';
import type { AuthClaim } from '../types/auth.js';
import type { SmsOtpProvider } from './provider.js';
import { SmsSendFailed } from './provider.js';
import type { OtpConfig } from './config.js';
import {
  OtpCooldownError,
  OtpLockedError,
  OtpExpiredError,
  NoOutstandingOtpError,
  InvalidOtpCodeError,
} from './errors.js';

export interface SendResult {
  expiresAt: Date;
  cooldownMs: number;
}

export interface VerifyResult {
  token: string;
  claim: AuthClaim;
  expiresAt: string;
}

interface OtpRow {
  id: string;
  phone_e164: string;
  code_hash: string;
  expires_at: Date;
  attempts: number;
  locked_until: Date | null;
  last_sent_at: Date;
  created_at: Date;
}

export class SmsOtpService {
  private readonly pool: pg.Pool;
  private readonly provider: SmsOtpProvider;
  private readonly cfg: OtpConfig;

  constructor(pool: pg.Pool, provider: SmsOtpProvider, cfg: OtpConfig) {
    this.pool = pool;
    this.provider = provider;
    this.cfg = cfg;
  }

  /**
   * Generate a 6-digit numeric code with uniform distribution via
   * `crypto.randomInt`. `padStart` handles leading zeros (e.g. 0..99 → '000123').
   */
  private generateCode(): string {
    const n = randomInt(0, 10 ** this.cfg.codeLength);
    return String(n).padStart(this.cfg.codeLength, '0');
  }

  /**
   * Compute `retryAfterMs` from a future Date. Defensive against clock skew
   * (returns 0 if the date is already past).
   */
  private msUntil(when: Date | null): number {
    if (!when) return 0;
    const ms = when.getTime() - Date.now();
    return ms > 0 ? ms : 0;
  }

  public async send(phone: string): Promise<SendResult> {
    const code = this.generateCode();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Step 1: cleanup any expired row for this phone. Plain UNIQUE on
      // phone_e164 means at most one outstanding row ever; this delete is
      // defense-in-depth so the INSERT never trips the unique constraint
      // spuriously.
      await client.query(
        `DELETE FROM otp_verification WHERE phone_e164 = $1 AND expires_at < now()`,
        [phone],
      );
      // Step 2: fetch the live row (if any) to evaluate cooldown + lockout.
      const rowResult = await client.query<OtpRow & { db_now: Date }>(
        `SELECT id, phone_e164, code_hash, expires_at, attempts, locked_until, last_sent_at, created_at,
                app_now() AS db_now
         FROM otp_verification WHERE phone_e164 = $1 FOR UPDATE`,
        [phone],
      );
      const row = rowResult.rows[0];
      // F8: anchor cooldown/lockout math to the DB clock, not Node's
      // wallclock. Two reasons:
      //   1. `last_sent_at` / `locked_until` were written by the DB, so
      //      comparing them to Node's `Date.now()` desyncs by however
      //      much the two clocks drift apart (containers/VMs on different
      //      time sources are common).
      //   2. `app_now()` is STABLE so it's safe to use here (it returns
      //      the same value for the lifetime of this statement).
      const now = row ? new Date(row.db_now).getTime() : Date.now();
      if (row) {
        // Lockout takes precedence over cooldown: a locked phone stays
        // locked even if the cooldown window has elapsed, until 10 minutes
        // pass since the lockout was set.
        if (row.locked_until && new Date(row.locked_until).getTime() > now) {
          await client.query('COMMIT');
          throw new OtpLockedError(this.msUntil(row.locked_until));
        }
        // Resend cooldown: 30s since the last send.
        const lastSent = new Date(row.last_sent_at).getTime();
        const cooldownMs = this.cfg.cooldownSeconds * 1000 - (now - lastSent);
        if (cooldownMs > 0) {
          await client.query('COMMIT');
          throw new OtpCooldownError(cooldownMs);
        }
      }
      // Step 3: insert (or replace) the row. The ON CONFLICT DO UPDATE path
      // covers the case where a row exists but neither locked nor in
      // cooldown — we rotate the code, attempts, locked_until, and reset
      // created_at / last_sent_at.
      // F-bytea: `pgcrypto.digest(...)::text` returns the bytea hex-escape
      // form (e.g. `\xb2e6...`) which is 66 chars and breaks AC-1/AC-2's
      // "sha-256 hex is exactly 64 chars" invariant. `encode(..., 'hex')`
      // yields the canonical 64-char lowercase hex string the spec promises
      // and what `Buffer.from(code_hash, 'utf8')` in verify() expects.
      const codeHashResult = await client.query<{ code_hash: string }>(
        `SELECT encode(pgcrypto.digest($1, 'sha256'), 'hex') AS code_hash`,
        [code],
      );
      const codeHash = codeHashResult.rows[0]!.code_hash;
      const expiresAt = new Date(now + this.cfg.ttlSeconds * 1000);
      const insertResult = await client.query<{ expires_at: Date }>(
        `INSERT INTO otp_verification (phone_e164, code_hash, expires_at, attempts, locked_until, last_sent_at, created_at)
         VALUES ($1, $2, $3, 0, NULL, app_now(), app_now())
         ON CONFLICT (phone_e164) DO UPDATE SET
           code_hash = EXCLUDED.code_hash,
           expires_at = EXCLUDED.expires_at,
           attempts = 0,
           locked_until = NULL,
           last_sent_at = EXCLUDED.last_sent_at,
           created_at = EXCLUDED.created_at
         RETURNING expires_at`,
        [phone, codeHash, expiresAt],
      );
      const newExpiresAt = insertResult.rows[0]!.expires_at;
      // Step 4: dispatch via the provider BEFORE committing so a provider
      // failure rolls back the INSERT and no orphan row remains. The user
      // then retries after the cooldown; the new send supersedes nothing.
      try {
        await this.provider.send(phone, code);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err instanceof SmsSendFailed) throw err;
        throw new SmsSendFailed('provider_threw_unknown', err);
      }
      await client.query('COMMIT');
      // F2: spec matrix pins `cooldown_ms: 0` on first-time send. The full
      // cooldown window is returned only on the cooldown REJECTION path
      // (429). Returning the full window on success confuses API consumers
      // who compute "next send allowed at = now + cooldown_ms" — that
      // would always be 30 seconds in the future, even immediately after a
      // successful verify, which contradicts the cooldown-resets contract.
      return {
        expiresAt: newExpiresAt,
        cooldownMs: 0,
      };
    } catch (err) {
      // If we already committed, the rollback is a no-op; pg ignores it.
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  public async verify(phone: string, code: string): Promise<VerifyResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const rowResult = await client.query<OtpRow & { db_now: Date }>(
        `SELECT id, phone_e164, code_hash, expires_at, attempts, locked_until, last_sent_at, created_at,
                app_now() AS db_now
         FROM otp_verification WHERE phone_e164 = $1 FOR UPDATE`,
        [phone],
      );
      const row = rowResult.rows[0];
      // F8: anchor lockout/expiry math to the DB clock (see send()).
      const now = row ? new Date(row.db_now).getTime() : Date.now();
      if (!row) {
        await client.query('COMMIT');
        throw new NoOutstandingOtpError();
      }
      if (row.locked_until && new Date(row.locked_until).getTime() > now) {
        // Locked: do NOT increment attempts. The lockout window is a hard
        // stop until it expires; counting failures during the lockout
        // would extend the window unpredictably.
        await client.query('COMMIT');
        throw new OtpLockedError(this.msUntil(row.locked_until));
      }
      if (new Date(row.expires_at).getTime() <= now) {
        await client.query('COMMIT');
        throw new OtpExpiredError();
      }
      // Compute the hash of the input via the DB so we compare against the
      // same digest the service stored. Doing the hash in Node would be
      // equivalent in correctness but loses the SQL-side symmetry that
      // makes the contract self-documenting.
      // F-bytea: same bytea→hex bug as the `send()` path — see comment above.
      // Using `encode(..., 'hex')` keeps the verify-side hash in the same
      // 64-char shape as the stored `code_hash`, so timingSafeEqual on equal
      // UTF-8 buffers actually compares the same byte representation.
      const inputHashResult = await client.query<{ code_hash: string }>(
        `SELECT encode(pgcrypto.digest($1, 'sha256'), 'hex') AS code_hash`,
        [code],
      );
      const inputHash = inputHashResult.rows[0]!.code_hash;
      // timingSafeEqual on equal-length buffers. Both are 64-char hex
      // (sha-256); lengths are guaranteed identical.
      const a = Buffer.from(row.code_hash, 'utf8');
      const b = Buffer.from(inputHash, 'utf8');
      const matches = a.length === b.length && timingSafeEqual(a, b);
      if (!matches) {
        const newAttempts = row.attempts + 1;
        const hitThreshold = newAttempts >= this.cfg.lockoutThreshold;
        if (hitThreshold) {
          const lockedUntil = new Date(now + this.cfg.lockoutSeconds * 1000);
          await client.query(
            `UPDATE otp_verification SET attempts = $2, locked_until = $3 WHERE id = $1`,
            [row.id, newAttempts, lockedUntil],
          );
        } else {
          await client.query(
            `UPDATE otp_verification SET attempts = $2 WHERE id = $1`,
            [row.id, newAttempts],
          );
        }
        await client.query('COMMIT');
        throw new InvalidOtpCodeError();
      }
      // Success path: delete the row in the same transaction, mint the
      // JWT, and return. The JWT minting is intentionally outside the
      // transaction's lock window — the row is already gone from the DB
      // before we hand the token to the caller.
      await client.query(`DELETE FROM otp_verification WHERE id = $1`, [row.id]);
      await client.query('COMMIT');
      const token = signClaim({
        sub: phone,
        role: 'patient',
        branch_ids: [],
        scope: 'self',
      });
      const claim = verifyToken(token);
      if (!claim) {
        // Unreachable: we just signed it with our own verifier's rules.
        throw new Error('sms_otp_mint_failed_internal');
      }
      const expiresAt = new Date(claim.expires_at * 1000).toISOString();
      return { token, claim, expiresAt };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
