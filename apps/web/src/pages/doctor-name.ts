/**
 * doctor-name — shared display helper for a doctor's full name.
 *
 * The seeded `doctor.full_name` values ALREADY carry their honorific
 * ("Dr. East Lead", "Mr. Jhon"). Several surfaces used to render
 * `Dr. {name}`, which produced "Dr. Dr. East Lead" and "Dr. Mr. Jhon".
 *
 * `withDoctorTitle` adds the "Dr." prefix ONLY when the name does not
 * already start with an honorific.
 */

/** Honorifics that a doctor name may already start with. */
const HONORIFICS = /^(dr|mr|mrs|ms|prof|sr)\.?\s/i;

/**
 * Render a doctor's full name with a "Dr." prefix, unless the name
 * already carries an honorific.
 *
 *   withDoctorTitle('Dr. East Lead') → 'Dr. East Lead'
 *   withDoctorTitle('Mr. Jhon')      → 'Mr. Jhon'
 *   withDoctorTitle('Ahmed Rashid')  → 'Dr. Ahmed Rashid'
 */
export function withDoctorTitle(fullName: string): string {
  const name = fullName.trim();
  if (name === '') return '';
  if (HONORIFICS.test(name)) return name;
  return `Dr. ${name}`;
}
