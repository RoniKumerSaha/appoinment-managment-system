/// <reference types="vite/client" />

/**
 * CSS Modules ambient declaration.
 *
 * `apps/web` uses Vite's CSS Modules feature for page-scoped styles.
 * Vite's runtime resolves the `*.module.css` import to a Proxy whose keys
 * are the source class names; `tsc` cannot infer this without help, hence
 * the typed shape below.
 *
 * If a page needs a class name that contains characters illegal in a JS
 * identifier (e.g. hyphens, slashes), it must use the bracket-access form:
 *   `styles['stat__label']`
 * instead of `styles.stat__label`. The page components in this app
 * already follow that convention (BEM-style `block__element` names).
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}