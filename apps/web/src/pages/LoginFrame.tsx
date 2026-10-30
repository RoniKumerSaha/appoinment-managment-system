/**
 * LoginFrame — the shared chrome for the three login screens.
 *
 * The login is now three separate screens (chooser / staff /
 * patient). They all sit on the same 760px frame with the same
 * MediSlot wordmark, so that chrome lives here rather than being
 * copied into each screen.
 *
 * The screens differ in what they render INSIDE `.page`: the chooser
 * renders its two big cards, the staff screen renders the staff
 * form, the patient screen renders the OTP form. Each owns its own
 * content — this component only owns the frame.
 *
 * There is no pill in the top-right. It used to read "Sign in", which
 * was true of all three screens and therefore told the visitor
 * nothing — and on the chooser it was actively misleading, because the
 * visitor has not chosen WHO to sign in as yet. The brand mark alone
 * is enough chrome.
 */
import type { ReactNode } from 'react';
import { BrandMark } from '../brand/BrandMark';
import { ShieldIcon } from './LoginIcons';
import styles from './LoginPage.module.css';

interface LoginFrameProps {
  children: ReactNode;
}

export function LoginFrame({ children }: LoginFrameProps) {
  return (
    <div className={styles['frame']}>
      <nav className={styles['nav']}>
        <div className={styles['brand']}>
          <BrandMark size={28} className={styles['brand__logo']} />
          MediSlot
        </div>
      </nav>

      <div className={styles['page']}>{children}</div>

      <div className={styles['privacy']}>
        <ShieldIcon />
        <span>
          All data is filtered server-side by your account. We never share
          your appointments. Authentication is required for every interaction
          with the clinic.
        </span>
      </div>
    </div>
  );
}
