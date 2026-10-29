/**
 * LoginFrame — the shared chrome for the three login screens.
 *
 * The login is now three separate screens (chooser / staff /
 * patient). They all sit on the same 760px frame with the same
 * MediSlot wordmark and the same "Sign in" pill, so that chrome
 * lives here rather than being copied into each screen.
 *
 * The screens differ in what they render INSIDE `.page`: the chooser
 * renders its two big cards, the staff screen renders the staff
 * form, the patient screen renders the OTP form. Each owns its own
 * content — this component only owns the frame.
 */
import type { ReactNode } from 'react';
import { BrandMark } from '../brand/BrandMark';
import styles from './LoginPage.module.css';

interface LoginFrameProps {
  children: ReactNode;
  /** The pill text in the top-right. Defaults to "Sign in". */
  pill?: string;
}

export function LoginFrame({ children, pill = 'Sign in' }: LoginFrameProps) {
  return (
    <div className={styles['frame']}>
      <nav className={styles['nav']}>
        <div className={styles['brand']}>
          <BrandMark size={28} className={styles['brand__logo']} />
          MediSlot
        </div>
        <div className={styles['nav__pill']}>{pill}</div>
      </nav>

      <div className={styles['page']}>{children}</div>

      <div className={styles['privacy']}>
        All data is filtered server-side by your account. We never share
        your appointments. Authentication is required for every interaction
        with the clinic.
      </div>
    </div>
  );
}
