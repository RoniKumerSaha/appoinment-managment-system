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
 */
import { LoginFrame } from './LoginFrame';
import { pushLoginRoute } from './login-routes';
import styles from './LoginPage.module.css';

interface ChooserCard {
  key: 'staff' | 'patient';
  icon: string;
  label: string;
  description: string;
  cta: string;
  testId: string;
}

const CARDS: ChooserCard[] = [
  {
    key: 'staff',
    icon: '◆',
    label: 'Staff',
    description: 'Admin, doctor, or receptionist at your clinic.',
    cta: 'Staff sign-in',
    testId: 'login-choose-staff',
  },
  {
    key: 'patient',
    icon: '👤',
    label: 'Patient',
    description: 'Book, reschedule, or cancel your appointments.',
    cta: 'Patient sign-in',
    testId: 'login-choose-patient',
  },
];

export function LoginChooser() {
  return (
    <LoginFrame pill="Sign in">
      <div className={styles['chooser']} data-testid="login-chooser">
        <h2 className={styles['chooser__title']}>
          Who are you signing in as?
        </h2>
        <p className={styles['chooser__sub']}>
          Choose the account type that matches you. You can switch later.
        </p>

        <div className={styles['chooser__grid']}>
          {CARDS.map((card) => (
            <button
              key={card.key}
              type="button"
              className={styles['chooser__card']}
              data-testid={card.testId}
              onClick={() => pushLoginRoute(card.key)}
            >
              <span className={styles['chooser__icon']} aria-hidden="true">
                {card.icon}
              </span>
              <span className={styles['chooser__label']}>{card.label}</span>
              <span className={styles['chooser__desc']}>
                {card.description}
              </span>
              <span className={styles['chooser__cta']}>{card.cta} →</span>
            </button>
          ))}
        </div>
      </div>
    </LoginFrame>
  );
}
