/* MediSlot — standalone-router.js
 *
 * Drop-in helper for browsing individual mockup files without the shell.
 * Mirrors the data-route click-to-navigate behavior of app/shell.js but
 * loads sibling winners directly via <iframe>-less navigation.
 *
 * Activation: any clickable element with a `data-route` attribute whose
 * value starts with "/" will navigate the current window to the matching
 * sibling file in ../winners/. Empty routes and __logo__ remain inert.
 *
 * Path resolution: this file lives at docs/design/mockups/v1/app/, and each
 * winner sits at docs/design/mockups/v1/winners/<name>.html. So when loaded
 * directly (e.g. file:// or webroot/winners/02-doctor-picker.html),
 * `../app/standalone-router.js` resolves correctly relative to the
 * winner file.
 *
 * Usage in a winner file:
 *   <script src="../app/standalone-router.js"></script>
 *   (place at the end of <body>)
 */

(function () {
  'use strict';

  // Map hash-style routes to the actual winner files.
  // Mirrors app/shell.js ROUTES table.
  var ROUTES = {
    '/':                       '01-layout-direction.html',
    '/patient/doctor':         '02-doctor-picker.html',
    '/patient/slot':           '03-availability-calendar.html',
    '/patient/confirm':        '04-patient-confirm.html',
    '/patient/manage':         '05-patient-self-service.html',
    '/patient/recurring':      '07-recurring-preview.html',
    '/doctor/schedule':        '09-doctor-schedule.html',
    '/doctor/block':           '10-doctor-block-time.html',
    '/doctor/types':           '11-appointment-types.html',
    '/doctor/today':           '12-mark-status.html',
    '/doctor/resolve':         '06-resolve-affected.html',
    '/doctor/recurring-preview':'07-recurring-preview.html',
    '/recep/today':            '13-recep-today.html',
    '/recep/create':           '14-recep-create.html',
    '/recep/cancel':           '15-recep-cancel.html',
    '/recep/availability':     '16-recep-availability.html',
    '/admin/branches':         '17-admin-branches.html',
    '/admin/branch-hours':     '08-branch-hours-impact.html',
    '/admin/doctors':          '18-admin-doctors.html',
    '/admin/receptionists':    '19-admin-receptionists.html'
  };

  // Resolve relative to this script's location. Since standalone-router.js
  // lives in ../app/ relative to the winner, the winners folder is one
  // level up from this script's directory. We compute that path.
  // (Same directory as the winner: ../winners/, this script: ../app/)
  // So from a winner at ../winners/X.html, `../winners/` = ../../winners/.
  // We detect the winners/ folder by stripping ../app from this script URL.
  var scriptUrl = (document.currentScript && document.currentScript.src) || '';
  var winnersBase = '';
  if (scriptUrl) {
    // e.g. .../v1/winners/../app/standalone-router.js  -> .../v1/winners/
    // Convert to absolute URL, then go up one to land in winners/.
    try {
      var u = new URL(scriptUrl);
      var path = u.pathname.replace(/\/app\/standalone-router\.js$/, '/winners/');
      winnersBase = u.origin + path;
    } catch (e) {
      winnersBase = '';
    }
  }

  document.addEventListener('click', function (e) {
    var el = e.target;
    var depth = 0;
    while (el && depth < 8) {
      if (el.dataset && el.dataset.route !== undefined) {
        var route = el.dataset.route;
        if (route === '' || route === '__logo__') return; // inert
        if (route && route.charAt(0) === '/' && ROUTES[route]) {
          e.preventDefault();
          e.stopPropagation();
          var target = winnersBase + ROUTES[route];
          window.location.href = target;
          return;
        }
        return;
      }
      el = el.parentElement;
      depth++;
    }
  }, true);

  // Hide demo badge in standalone mode too (consistency with shell)
  try {
    var badge = document.querySelector('.badge');
    if (badge) badge.style.display = 'none';
  } catch (_) {}

  // Make logos look clickable
  try {
    document.querySelectorAll('.logo').forEach(function (el) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', function (e) {
        if (el.dataset && el.dataset.route === '__logo__') {
          // In standalone, "logo home" lands on the landing page.
          window.location.href = winnersBase + ROUTES['/'];
        }
      });
    });
  } catch (_) {}
})();