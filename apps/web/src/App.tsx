/**
 * E0-S1 placeholder.
 *
 * The only UX obligation is to consume design tokens by name — no literal hex.
 * `prefers-reduced-motion` is honored in tokens.css (transitions disabled when
 * the user opts out). No web fonts are loaded; the system stack only.
 */
export function App() {
  return (
    <main className="placeholder">
      <h1 className="placeholder__heading">Clinic Scheduling — E0-S1</h1>
      <p className="placeholder__body">
        Repo skeleton. Real flows ship from E1 onward.
      </p>
    </main>
  );
}
