/**
 * login-hashes — the hash constants for the three login screens.
 *
 * They live in `auth/` rather than `pages/` because BOTH the auth
 * store and the login screens need them:
 *
 *   - `auth/store.ts` resets the URL to the chooser on sign-out, so
 *     signing out of the patient screen doesn't bounce the user back
 *     to the patient form they just left.
 *   - `pages/login-routes.ts` parses the hash and navigates between
 *     the screens.
 *
 * Keeping the constants here means `auth/` does not have to import
 * from `pages/` (a layering inversion), and the two sides cannot
 * drift apart on the literal.
 */

/** The chooser — also the app root's landing screen. */
export const LOGIN_CHOOSE_HASH = '#/login';

/** The staff sign-in screen. */
export const LOGIN_STAFF_HASH = '#/login/staff';

/** The patient sign-in screen. */
export const LOGIN_PATIENT_HASH = '#/login/patient';
