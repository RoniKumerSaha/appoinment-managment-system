/**
 * LoginChooser — the app root's landing screen for an
 * unauthenticated visitor.
 *
 * The login used to be one page with two cards on it: staff sign-in
 * on the left, patient OTP on the right. That layout forced each
 * audience to look at the other's form — a patient saw a role
 * dropdown and a staff password field, a staff member saw an OTP
 * widget.
 *
 * The chooser asks the one question that actually separates them,
 * then hands off to `#/login/staff` or `#/login/patient`.
 *
 * This is what renders at `/` with no hash, so a bare `page.goto('/')`
 * still lands on a usable login screen.
 *
 * ── Layout ────────────────────────────────────────────────────────
 * A split hero: a brand panel on the left that carries the product
 * story, and the chooser cards on the right. The earlier version
 * stacked the cards in a wide, empty white column with a lot of dead
 * space beneath the fold and no visual anchor — the split hero gives
 * the eye somewhere to land and states what the product IS before
 * asking who the visitor is.
 *
 * The card icons are inline SVG rather than the old glyph characters
 * (`◆`, `👤`). The emoji rendered as a full-colour system glyph that
 * clashed with the monoline brand mark and broke the token-only colour
 * rule (it could not inherit `currentColor`).
 */
import { LoginFrame } from './LoginFrame';
import { pushLoginRoute } from './login-routes';
import styles from './LoginPage.module.css';

interface ChooserCard {
  key: 'staff' | 'patient';
  icon: 'staff' | 'patient';
  label: string;
  description: string;
  points: string[];
  cta: string;
  testId: string;
}

const CARDS: ChooserCard[] = [
  {
    key: 'staff',
    icon: 'staff',
    label: 'Staff',
    description: 'Admin, doctor, or receptionist at your clinic.',
    points: [
      'Manage branches, hours and doctors',
      'Confirm, complete and cancel appointments',
      'Run availability and recurring series',
    ],
    cta: 'Staff sign-in',
    testId: 'login-choose-staff',
  },
  {
    key: 'patient',
    icon: 'patient',
    label: 'Patient',
    description: 'Book, reschedule, or cancel your appointments.',
    points: [
      'Find a slot across every branch',
      'Book or reschedule in a few taps',
      'Get a reminder by SMS',
    ],
    cta: 'Patient sign-in',
    testId: 'login-choose-patient',
  },
];

/**
 * Monoline icons, sized by the `1em` font-size of their wrapper.
 * Both inherit `currentColor` so the tile can tint them.
 */
function ChooserIcon({ name }: { name: 'staff' | 'patient' }) {
  if (name === 'staff') {
    // Stethoscope around a person — "clinical staff".
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M6 3v5a4 4 0 0 0 8 0V3" />
        <path d="M4.5 3h3M12.5 3h3" />
        <path d="M10 12v2.5a4.5 4.5 0 0 0 9 0V13" />
        <circle cx="19" cy="11" r="2" />
      </svg>
    );
  }
  // Person in a rounded frame — "patient".
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </svg>
  );
}

export function LoginChooser() {
  return (
    <LoginFrame pill="Sign in">
      <div className={styles['chooser']} data-testid="login-chooser">
        {/* ── Brand panel ─────────────────────────────────────────── */}
        <aside className={styles['chooser__hero']}>
          <span className={styles['chooser__eyebrow']}>Clinic scheduling</span>
          <h2 className={styles['chooser__headline']}>
            Every appointment,
            <br />
            in one calm place.
          </h2>
          <p className={styles['chooser__lede']}>
            One system for your front desk, your doctors, and your patients —
            from the first booking to the final note.
          </p>

          <ul className={styles['chooser__stats']}>
            <li className={styles['chooser__stat']}>
              <strong className={styles['chooser__statNum']}>Real-time</strong>
              <span className={styles['chooser__statLabel']}>
                availability
              </span>
            </li>
            <li className={styles['chooser__stat']}>
              <strong className={styles['chooser__statNum']}>Multi-branch</strong>
              <span className={styles['chooser__statLabel']}>scheduling</span>
            </li>
            <li className={styles['chooser__stat']}>
              <strong className={styles['chooser__statNum']}>Zero</strong>
              <span className={styles['chooser__statLabel']}>double bookings</span>
            </li>
          </ul>

          {/* Decorative calendar grid — brand texture, not content. */}
          <svg
            className={styles['chooser__art']}
            viewBox="0 0 320 200"
            fill="none"
            aria-hidden="true"
            focusable="false"
          >
            <rect
              x="20"
              y="24"
              width="280"
              height="170"
              rx="16"
              stroke="currentColor"
              strokeWidth="1.5"
              opacity="0.5"
            />
            <line
              x1="20"
              y1="62"
              x2="300"
              y2="62"
              stroke="currentColor"
              strokeWidth="1.5"
              opacity="0.5"
            />
            <line
              x1="80"
              y1="24"
              x2="80"
              y2="194"
              stroke="currentColor"
              strokeWidth="1.5"
              opacity="0.35"
            />
            <line
              x1="140"
              y1="24"
              x2="140"
              y2="194"
              stroke="currentColor"
              strokeWidth="1.5"
              opacity="0.35"
            />
            <line
              x1="200"
              y1="24"
              x2="200"
              y2="194"
              stroke="currentColor"
              strokeWidth="1.5"
              opacity="0.35"
            />
            <line
              x1="260"
              y1="24"
              x2="260"
              y2="194"
              stroke="currentColor"
              strokeWidth="1.5"
              opacity="0.35"
            />
            {/* Filled slots — the "booked" state. */}
            <rect
              x="36"
              y="80"
              width="34"
              height="26"
              rx="6"
              fill="currentColor"
              opacity="0.55"
            />
            <rect
              x="96"
              y="80"
              width="34"
              height="26"
              rx="6"
              fill="currentColor"
              opacity="0.9"
            />
            <rect
              x="156"
              y="118"
              width="34"
              height="26"
              rx="6"
              fill="currentColor"
              opacity="0.55"
            />
            <rect
              x="216"
              y="118"
              width="34"
              height="26"
              rx="6"
              fill="currentColor"
              opacity="0.9"
            />
            {/* Slot rings */}
            <circle cx="103" cy="145" r="13" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
            <circle cx="163" cy="80" r="13" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
            <circle cx="283" cy="80" r="13" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
          </svg>
        </aside>

        {/* ── Chooser cards ───────────────────────────────────────── */}
        <div className={styles['chooser__panel']}>
          <div className={styles['chooser__head']}>
            <h3 className={styles['chooser__title']}>
              Who are you signing in as?
            </h3>
            <p className={styles['chooser__sub']}>
              Choose the account type that matches you. You can switch later.
            </p>
          </div>

          <div className={styles['chooser__grid']}>
            {CARDS.map((card) => (
              <button
                key={card.key}
                type="button"
                className={styles['chooser__card']}
                data-testid={card.testId}
                onClick={() => pushLoginRoute(card.key)}
              >
                <span className={styles['chooser__cardTop']}>
                  <span
                    className={`${styles['chooser__icon']} ${styles[`chooser__icon--${card.key}`]}`}
                  >
                    <ChooserIcon name={card.icon} />
                  </span>
                  <span className={styles['chooser__label']}>{card.label}</span>
                </span>

                <span className={styles['chooser__desc']}>
                  {card.description}
                </span>

                <ul className={styles['chooser__points']}>
                  {card.points.map((point) => (
                    <li key={point} className={styles['chooser__point']}>
                      <svg
                        className={styles['chooser__check']}
                        viewBox="0 0 16 16"
                        fill="none"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <path
                          d="M3.5 8.5l3 3 6-7"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      {point}
                    </li>
                  ))}
                </ul>

                <span className={styles['chooser__cta']}>
                  {card.cta}
                  <svg
                    className={styles['chooser__arrow']}
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <path
                      d="M3 8h9m0 0l-3.5-3.5M12 8l-3.5 3.5"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </LoginFrame>
  );
}
