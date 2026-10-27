/**
 * phone-countries.ts — the country-dial-code catalogue behind the
 * phone field's country chip.
 *
 * Mockup 41 (Q5) puts +966 in the chip and offers the other GCC
 * codes one tap away, plus an "Other country" escape hatch for a
 * patient on roaming. The API validates phones by E.164 country
 * code (not by branch address), so the catalogue is presentation
 * only — the server accepts any +CC… number.
 *
 * `OTHER` is a sentinel, not a country: picking it hands the whole
 * number to the input so the patient can dial their own prefix.
 */
export interface CountryDialCode {
  /** ISO 3166-1 alpha-2, or `OTHER` for the escape hatch. */
  code: string;
  name: string;
  /** The E.164 prefix, including the leading `+`. Empty for
   *  `OTHER` — the patient supplies their own. */
  dial: string;
  flag: string;
}

export const DEFAULT_COUNTRY_CODE = 'SA';

/** Gulf presets first — they are the overwhelmingly common case
 *  (P-03: +966 is one tap, the rest are one tap away). */
export const GULF_COUNTRIES: CountryDialCode[] = [
  { code: 'SA', name: 'Saudi Arabia', dial: '+966', flag: '🇸🇦' },
  { code: 'AE', name: 'United Arab Emirates', dial: '+971', flag: '🇦🇪' },
  { code: 'KW', name: 'Kuwait', dial: '+965', flag: '🇰🇼' },
  { code: 'BH', name: 'Bahrain', dial: '+973', flag: '🇧🇭' },
  { code: 'QA', name: 'Qatar', dial: '+974', flag: '🇶🇦' },
  { code: 'OM', name: 'Oman', dial: '+968', flag: '🇴🇲' },
];

/** Common international destinations, so the common case of a
 *  patient booking from abroad does not require "Other". */
export const INTERNATIONAL_COUNTRIES: CountryDialCode[] = [
  { code: 'EG', name: 'Egypt', dial: '+20', flag: '🇪🇬' },
  { code: 'JO', name: 'Jordan', dial: '+962', flag: '🇯🇴' },
  { code: 'LB', name: 'Lebanon', dial: '+961', flag: '🇱🇧' },
  { code: 'IQ', name: 'Iraq', dial: '+964', flag: '🇮🇶' },
  { code: 'SY', name: 'Syria', dial: '+963', flag: '🇸🇾' },
  { code: 'YE', name: 'Yemen', dial: '+967', flag: '🇾🇪' },
  { code: 'PS', name: 'Palestine', dial: '+970', flag: '🇵🇸' },
  { code: 'TR', name: 'Türkiye', dial: '+90', flag: '🇹🇷' },
  { code: 'PK', name: 'Pakistan', dial: '+92', flag: '🇵🇰' },
  { code: 'IN', name: 'India', dial: '+91', flag: '🇮🇳' },
  { code: 'PH', name: 'Philippines', dial: '+63', flag: '🇵🇭' },
  { code: 'ID', name: 'Indonesia', dial: '+62', flag: '🇮🇩' },
  { code: 'MY', name: 'Malaysia', dial: '+60', flag: '🇲🇾' },
  { code: 'GB', name: 'United Kingdom', dial: '+44', flag: '🇬🇧' },
  { code: 'FR', name: 'France', dial: '+33', flag: '🇫🇷' },
  { code: 'DE', name: 'Germany', dial: '+49', flag: '🇩🇪' },
  { code: 'US', name: 'United States', dial: '+1', flag: '🇺🇸' },
  { code: 'CA', name: 'Canada', dial: '+1', flag: '🇨🇦' },
  { code: 'AU', name: 'Australia', dial: '+61', flag: '🇦🇺' },
];

/** The escape hatch: the patient types their own full international
 *  number, prefix included. */
export const OTHER_COUNTRY: CountryDialCode = {
  code: 'OTHER',
  name: 'Other country',
  dial: '',
  flag: '🌐',
};

export const ALL_COUNTRIES: CountryDialCode[] = [
  ...GULF_COUNTRIES,
  ...INTERNATIONAL_COUNTRIES,
  OTHER_COUNTRY,
];

export function findCountry(code: string): CountryDialCode | undefined {
  return ALL_COUNTRIES.find((c) => c.code === code);
}

/** Filter the catalogue by a free-text query. The query matches the
 *  country name, the ISO code, or the dial code — so "+971", "uae"
 *  and "United Arab Emirates" all find the same row. `OTHER` is
 *  always kept: it is the fallback for every country that is not in
 *  the list, so hiding it on a search miss would leave a patient
 *  with no way to enter their number at all. */
export function searchCountries(query: string): {
  gulf: CountryDialCode[];
  international: CountryDialCode[];
  other: CountryDialCode | null;
} {
  const q = query.trim().toLowerCase();
  if (q === '') {
    return {
      gulf: GULF_COUNTRIES,
      international: INTERNATIONAL_COUNTRIES,
      other: OTHER_COUNTRY,
    };
  }
  const matches = (c: CountryDialCode): boolean =>
    c.name.toLowerCase().includes(q) ||
    c.code.toLowerCase().includes(q) ||
    c.dial.includes(q);
  return {
    gulf: GULF_COUNTRIES.filter(matches),
    international: INTERNATIONAL_COUNTRIES.filter(matches),
    other: OTHER_COUNTRY,
  };
}
