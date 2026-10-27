/**
 * PhoneCountryPicker — the country-code chip + dropdown beside the
 * patient's phone input.
 *
 * Mockup 41 (Q5): the chip shows the selected country and opens a
 * searchable listbox. The list is grouped — Gulf presets, then
 * international, then the "Other country" escape hatch for a
 * patient on roaming who types their own full international number.
 *
 * The selected dial code is a PREFIX: the national number lives in
 * the adjacent input, and the full E.164 string is the two
 * concatenated. `OTHER` contributes no prefix — the patient types
 * the whole number including their own `+CC`.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import styles from './PhoneCountryPicker.module.css';
import {
  DEFAULT_COUNTRY_CODE,
  OTHER_COUNTRY,
  findCountry,
  searchCountries,
  type CountryDialCode,
} from './phone-countries';

export interface PhoneCountryPickerProps {
  /** Fired with an empty national number when the country changes —
   *  a number typed against the old country would otherwise become
   *  a valid-looking but wrong E.164 string. */
  onCountryChange: (code: string) => void;
  /** The currently selected country code (ISO 3166-1 alpha-2, or
   *  `OTHER`). */
  countryCode: string;
  disabled?: boolean;
}

export function PhoneCountryPicker({
  onCountryChange,
  countryCode,
  disabled,
}: PhoneCountryPickerProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const selected = useMemo(
    () => findCountry(countryCode) ?? findCountry(DEFAULT_COUNTRY_CODE),
    [countryCode],
  );

  const groups = useMemo(() => searchCountries(query), [query]);

  // Close on an outside click or Escape — a listbox that stays open
  // over the rest of the form blocks the next step.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (open && searchRef.current !== null) searchRef.current.focus();
  }, [open]);

  const choose = useCallback(
    (country: CountryDialCode) => {
      onCountryChange(country.code);
      setOpen(false);
      setQuery('');
    },
    [onCountryChange],
  );

  const renderItem = (c: CountryDialCode): ReactNode => (
    <button
      key={c.code}
      type="button"
      role="option"
      aria-selected={c.code === countryCode}
      className={
        c.code === countryCode
          ? `${styles['cc-item']} ${styles['cc-item-selected']}`
          : styles['cc-item']
      }
      onClick={() => choose(c)}
    >
      <span className={styles['cc-item__flag']} aria-hidden="true">
        {c.flag}
      </span>
      <span className={styles['cc-item__name']}>{c.name}</span>
      <span className={styles['cc-item__code']}>
        {c.dial === '' ? '+___' : c.dial}
      </span>
      {c.code === countryCode && (
        <span className={styles['cc-item__check']} aria-hidden="true">
          ✓
        </span>
      )}
    </button>
  );

  const nothing =
    groups.gulf.length === 0 && groups.international.length === 0;

  return (
    <div className={styles['cc-wrap']} ref={rootRef}>
      <button
        type="button"
        className={styles['cc-chip']}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={`Country code: ${selected?.name ?? 'Other country'}`}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles['cc-chip__flag']} aria-hidden="true">
          {selected?.flag ?? OTHER_COUNTRY.flag}
        </span>
        <span className={styles['cc-chip__code']}>
          {selected?.dial === '' || selected === undefined ? '+' : selected.dial}
        </span>
        <span className={styles['cc-chip__caret']} aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className={styles['cc-dropdown']} id={listboxId} role="listbox">
          <input
            ref={searchRef}
            type="search"
            className={styles['cc-search']}
            placeholder="Search country or code…"
            aria-label="Search country"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {nothing && (
            <div className={styles['cc-empty']}>
              No country matches “{query}”. Choose “Other country” and type
              your full number.
            </div>
          )}
          {groups.gulf.length > 0 && (
            <>
              <div className={styles['cc-section']}>Gulf · preset</div>
              <div className={styles['cc-list']}>
                {groups.gulf.map(renderItem)}
              </div>
            </>
          )}
          {groups.international.length > 0 && (
            <>
              <div className={styles['cc-section']}>
                International · dial-out
              </div>
              <div className={styles['cc-list']}>
                {groups.international.map(renderItem)}
              </div>
            </>
          )}
          {groups.other !== null && (
            <>
              <div className={styles['cc-section']}>International · other</div>
              <div className={styles['cc-list']}>
                {renderItem(groups.other)}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
