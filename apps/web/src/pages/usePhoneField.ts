/**
 * usePhoneField — the country chip + phone input, kept in sync.
 *
 * The patient is NOT required to work with the country code. They
 * may type the whole international number (`+8801684960808`) and the
 * chip follows along; or they may type a national number
 * (`01684960808`) and the selected chip's dial code is prefixed.
 *
 * The rule the API forces on us: the number we submit must be E.164
 * (`^\+[1-9]\d{6,14}$`). So the hook always exposes a joined string
 * that is E.164-shaped, and the chip is a convenience that never
 * overrides a prefix the patient typed themselves.
 *
 * Shared by the public booking flow (`PatientBooking`) and the
 * receptionist walk-in form (`ReceptionistCreate`) so both behave
 * identically.
 */
import { useCallback, useMemo, useState } from 'react';
import { DEFAULT_COUNTRY_CODE, findCountry } from './phone-countries';
import { detectCountryCode, joinPhone } from './booking-utils';

export interface PhoneFieldState {
  /** The selected country code (ISO 3166-1 alpha-2, or `OTHER`). */
  countryCode: string;
  /** The raw text in the input — exactly what the patient typed. */
  nationalNumber: string;
  /** The joined E.164 string the API receives. */
  phone: string;
  /** Fired by the chip: the country changed, so the number is reset. */
  onCountryChange: (code: string) => void;
  /** Fired by the input: the patient typed (or pasted) a number. */
  onNumberChange: (value: string) => void;
  /** Clears the field back to its initial country and an empty number. */
  reset: () => void;
  /** The country name for display, e.g. "Saudi Arabia". */
  countryName: string;
}

export function usePhoneField(
  initialCountryCode: string = DEFAULT_COUNTRY_CODE,
): PhoneFieldState {
  const [countryCode, setCountryCode] = useState<string>(initialCountryCode);
  const [nationalNumber, setNationalNumber] = useState<string>('');

  const onCountryChange = useCallback((code: string): void => {
    setCountryCode(code);
    // The national number belongs to the country, not the other way
    // round — keeping a number typed against the old country would
    // produce a valid-looking but wrong E.164 string. An explicitly
    // typed international number is the exception: it carries its own
    // country code, so it survives the switch.
    setNationalNumber((prev) =>
      prev.replace(/[\s\-().]/g, '').startsWith('+') ? prev : '',
    );
  }, []);

  const onNumberChange = useCallback((value: string): void => {
    setNationalNumber(value);
    // The patient typed a full international number. Follow the
    // country code they typed rather than forcing the chip's.
    const detected = detectCountryCode(value);
    if (detected !== null) setCountryCode(detected);
  }, []);

  const phone = useMemo(
    () => joinPhone(countryCode, nationalNumber),
    [countryCode, nationalNumber],
  );

  const countryName = useMemo(
    () => findCountry(countryCode)?.name ?? 'Other country',
    [countryCode],
  );

  const reset = useCallback((): void => {
    setCountryCode(initialCountryCode);
    setNationalNumber('');
  }, [initialCountryCode]);

  return {
    countryCode,
    nationalNumber,
    phone,
    onCountryChange,
    onNumberChange,
    reset,
    countryName,
  };
}
