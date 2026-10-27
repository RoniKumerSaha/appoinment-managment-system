/**
 * usePhoneField — the phone input, normalised for the API.
 *
 * The patient types the whole international number — `+966512345678`,
 * `+880 1684 960808`, `+1 (555) 123-4567`. There is no country
 * picker: the country code is part of the number, the way it is in
 * every other booking app.
 *
 * The rule the API forces on us: the number we submit must be E.164
 * (`^\+[1-9]\d{6,14}$`). The hook exposes:
 *   - `phone`   — the raw text in the input (what the patient typed)
 *   - `e164`    — the normalised string the API receives
 *   - `isValid` — whether `e164` satisfies the API's regex
 *
 * Shared by the public booking flow (`PatientBooking`) and the
 * receptionist walk-in form (`ReceptionistCreate`) so both behave
 * identically.
 */
import { useCallback, useMemo, useState } from 'react';
import { isValidPhone, normalizePhone } from './booking-utils';

export interface PhoneFieldState {
  /** The raw text in the input — exactly what the patient typed. */
  phone: string;
  /** The normalised E.164 string the API receives. */
  e164: string;
  /** Whether the normalised number satisfies the API's E.164 rule. */
  isValid: boolean;
  /** Fired by the input: the patient typed (or pasted) a number. */
  onPhoneChange: (value: string) => void;
  /** Clears the field. */
  reset: () => void;
}

export function usePhoneField(initialPhone = ''): PhoneFieldState {
  const [phone, setPhone] = useState<string>(initialPhone);

  const onPhoneChange = useCallback((value: string): void => {
    setPhone(value);
  }, []);

  const e164 = useMemo(() => normalizePhone(phone), [phone]);
  const isValid = useMemo(() => isValidPhone(e164), [e164]);

  const reset = useCallback((): void => {
    setPhone(initialPhone);
  }, [initialPhone]);

  return {
    phone,
    e164,
    isValid,
    onPhoneChange,
    reset,
  };
}
