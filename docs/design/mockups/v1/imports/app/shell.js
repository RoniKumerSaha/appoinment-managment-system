/* MediSlot app shell — hash router + role switcher + click-to-route wiring
 *
 * 36 winner mockups are loaded into a single iframe.
 * Each mockup has data-route attributes on its clickable elements
 * (button / a / .logo). The injection script below reads those
 * attributes and routes accordingly.
 *
 * SPA feel:
 *  - Iframe fades on every navigation (160ms).
 *  - Breadcrumbs are clickable (click earlier crumb → navigate).
 *  - Quick-jump dropdown in topbar reaches any of the 36 mockups.
 *  - History via location.hash (back/forward buttons work).
 *  - Topbar role select jumps to that role's home route.
 *
 * Path resolution: this file lives at docs/design/mockups/v1/app/, so `../partNN-…`
 * resolves to docs/design/mockups/v1/partNN-… which is where each winner sits.
 */

(function () {
  'use strict';

  // ─── Route table ────────────────────────────────────────────────────────
  // Each entry maps a hash to { file, actor, title, breadcrumb, isHome }
  // Note: this shell lives at v1/imports/app/index.html and loads mockups
  // from v1/mockups/, so file paths go up two levels.
  const ROUTES = {
    '/': {
      file: '../../mockups/01-layout-direction.html',
      actor: 'landing',
      title: 'Landing · Find your doctor',
      breadcrumb: ['Landing'],
      isHome: true,
    },

    // Patient
    '/patient/doctor': {
      file: '../../mockups/02-doctor-picker.html',
      actor: 'patient',
      title: 'Choose a branch & appointment type',
      breadcrumb: ['Patient', 'Choose a branch & type'],
      isHome: true,
    },
    '/patient/slot': {
      file: '../../mockups/03-availability-calendar.html',
      actor: 'patient',
      title: 'Pick a date and time',
      breadcrumb: ['Patient', 'Pick a date and time'],
    },
    '/patient/confirm': {
      file: '../../mockups/04-patient-confirm.html',
      actor: 'patient',
      title: 'Confirm your booking',
      breadcrumb: ['Patient', 'Confirm your booking'],
    },
    '/patient/manage': {
      file: '../../mockups/05-patient-self-service.html',
      actor: 'patient',
      title: 'Manage your appointments',
      breadcrumb: ['Patient', 'Manage your appointments'],
      isHome: true,
    },
    '/patient/recurring': {
      file: '../../mockups/07-recurring-preview.html',
      actor: 'patient',
      title: 'Recurring series preview',
      breadcrumb: ['Patient', 'Recurring series'],
    },
    '/patient/branch': {
      file: '../../mockups/34-patient-branch-picker.html',
      actor: 'patient',
      title: 'Choose a branch',
      breadcrumb: ['Patient', 'Choose a branch'],
    },
    '/patient/type': {
      file: '../../mockups/35-patient-type-picker.html',
      actor: 'patient',
      title: 'Choose an appointment type',
      breadcrumb: ['Patient', 'Choose a type'],
    },
    '/patient/receipt': {
      file: '../../mockups/36-confirmation-receipt.html',
      actor: 'patient',
      title: 'Booking confirmed',
      breadcrumb: ['Patient', 'Booking receipt'],
    },
    '/patient/otp': {
      file: '../../mockups/21-patient-otp-modal.html',
      actor: 'patient',
      title: 'Verify your phone',
      breadcrumb: ['Patient', 'Manage', 'OTP'],
    },
    '/patient/cancel-confirm': {
      file: '../../mockups/22-patient-cancel-confirm.html',
      actor: 'patient',
      title: 'Cancel your appointment',
      breadcrumb: ['Patient', 'Manage', 'Cancel'],
    },
    '/patient/reschedule': {
      file: '../../mockups/20-patient-reschedule.html',
      actor: 'patient',
      title: 'Reschedule your appointment',
      breadcrumb: ['Patient', 'Manage', 'Reschedule'],
    },

    // Doctor
    '/doctor/schedule': {
      file: '../../mockups/09-doctor-schedule.html',
      actor: 'doctor',
      title: 'Manage weekly schedule',
      breadcrumb: ['Doctor', 'Weekly schedule'],
      isHome: true,
    },
    '/doctor/block': {
      file: '../../mockups/10-doctor-block-time.html',
      actor: 'doctor',
      title: 'Block time off',
      breadcrumb: ['Doctor', 'Block time off'],
    },
    '/doctor/types': {
      file: '../../mockups/11-appointment-types.html',
      actor: 'doctor',
      title: 'Manage appointment types',
      breadcrumb: ['Doctor', 'Appointment types'],
    },
    '/doctor/today': {
      file: '../../mockups/12-mark-status.html',
      actor: 'doctor',
      title: "Today · Mark status",
      breadcrumb: ['Doctor', "Today's list"],
    },
    '/doctor/resolve': {
      file: '../../mockups/06-resolve-affected.html',
      actor: 'doctor',
      title: 'Resolve affected appointments',
      breadcrumb: ['Doctor', 'Resolve affected'],
    },
    '/doctor/recurring-preview': {
      file: '../../mockups/23-recurring-confirm.html',
      actor: 'doctor',
      title: 'Preview recurring series',
      breadcrumb: ['Doctor', 'Recurring preview'],
    },
    '/recurring/confirm': {
      file: '../../mockups/23-recurring-confirm.html',
      actor: 'doctor',
      title: 'Recurring series · ready',
      breadcrumb: ['Doctor', 'Recurring confirm'],
    },
    '/doctor/resolve-one': {
      file: '../../mockups/24-doctor-resolve-one.html',
      actor: 'doctor',
      title: 'Resolve this appointment',
      breadcrumb: ['Doctor', 'Resolve affected', 'One'],
    },
    '/doctor/cancel-reason': {
      file: '../../mockups/25-doctor-cancel-reason.html',
      actor: 'doctor',
      title: 'Cancel this appointment',
      breadcrumb: ['Doctor', 'Today', 'Cancel reason'],
    },
    '/doctor/audit-drawer': {
      file: '../../mockups/30-doctor-audit-drawer.html',
      actor: 'doctor',
      title: 'Audit log',
      breadcrumb: ['Doctor', 'Audit log'],
    },
    '/doctor/resolution-saved': {
      file: '../../mockups/37-doctor-resolution-saved.html',
      actor: 'doctor',
      title: 'All appointments resolved',
      breadcrumb: ['Doctor', 'Resolve affected', 'Saved'],
    },

    // Receptionist
    '/recep/today': {
      file: '../../mockups/13-recep-today.html',
      actor: 'recep',
      title: "Today's branch view",
      breadcrumb: ['Receptionist', "Today's view"],
      isHome: true,
    },
    '/recep/create': {
      file: '../../mockups/14-recep-create.html',
      actor: 'recep',
      title: 'Book on behalf of patient',
      breadcrumb: ['Receptionist', 'Book on behalf'],
    },
    '/recep/cancel': {
      file: '../../mockups/15-recep-cancel.html',
      actor: 'recep',
      title: 'Cancel an appointment',
      breadcrumb: ['Receptionist', 'Cancel appointment'],
    },
    '/recep/availability': {
      file: '../../mockups/16-recep-availability.html',
      actor: 'recep',
      title: 'Doctor availability · read-only',
      breadcrumb: ['Receptionist', 'Doctor availability'],
    },
    '/recep/checkin': {
      file: '../../mockups/26-recep-checkin.html',
      actor: 'recep',
      title: 'Walk-in patient check-in',
      breadcrumb: ['Receptionist', 'Walk-in check-in'],
    },

    // Admin
    '/admin/branches': {
      file: '../../mockups/17-admin-branches.html',
      actor: 'admin',
      title: 'Manage branches',
      breadcrumb: ['Admin', 'Branches'],
      isHome: true,
    },
    '/admin/branch-hours': {
      file: '../../mockups/08-branch-hours-impact.html',
      actor: 'admin',
      title: 'Branch hours change impact',
      breadcrumb: ['Admin', 'Branch hours · impact'],
    },
    '/admin/doctors': {
      file: '../../mockups/18-admin-doctors.html',
      actor: 'admin',
      title: 'Manage doctors',
      breadcrumb: ['Admin', 'Doctors'],
    },
    '/admin/receptionists': {
      file: '../../mockups/19-admin-receptionists.html',
      actor: 'admin',
      title: 'Manage receptionists',
      breadcrumb: ['Admin', 'Receptionists'],
    },
    '/admin/branch-new': {
      file: '../../mockups/17-admin-branches.html',
      actor: 'admin',
      title: 'Create new branch',
      breadcrumb: ['Admin', 'Branches', 'New'],
    },
    '/admin/doctor-edit': {
      file: '../../mockups/18-admin-doctors.html',
      actor: 'admin',
      title: 'Edit doctor',
      breadcrumb: ['Admin', 'Doctors', 'Edit'],
    },
    '/admin/doctor-new': {
      file: '../../mockups/18-admin-doctors.html',
      actor: 'admin',
      title: 'Create new doctor',
      breadcrumb: ['Admin', 'Doctors', 'New'],
    },
    '/admin/recep-edit': {
      file: '../../mockups/19-admin-receptionists.html',
      actor: 'admin',
      title: 'Edit receptionist',
      breadcrumb: ['Admin', 'Receptionists', 'Edit'],
    },
    '/admin/recep-assign': {
      file: '../../mockups/19-admin-receptionists.html',
      actor: 'admin',
      title: 'Reassign receptionist',
      breadcrumb: ['Admin', 'Receptionists', 'Reassign'],
    },
    '/admin/recep-new': {
      file: '../../mockups/19-admin-receptionists.html',
      actor: 'admin',
      title: 'Create new receptionist',
      breadcrumb: ['Admin', 'Receptionists', 'New'],
    },
    '/admin/audit': {
      file: '../../mockups/27-admin-audit-log.html',
      actor: 'admin',
      title: 'Activity & audit log',
      breadcrumb: ['Admin', 'Audit log'],
    },
    '/admin/branch-hours-editor': {
      file: '../../mockups/28-admin-branch-hours-editor.html',
      actor: 'admin',
      title: 'Edit operating hours',
      breadcrumb: ['Admin', 'Branches', 'Hours editor'],
    },
    '/admin/doctor-reassign': {
      file: '../../mockups/31-admin-doctors-reassign.html',
      actor: 'admin',
      title: 'Reassign branches',
      breadcrumb: ['Admin', 'Doctors', 'Reassign'],
    },
    '/admin/clinic': {
      file: '../../mockups/32-admin-clinic-settings.html',
      actor: 'admin',
      title: 'Clinic settings',
      breadcrumb: ['Admin', 'Clinic'],
    },
    '/admin/branch-deactivate': {
      file: '../../mockups/38-admin-branch-deactivate.html',
      actor: 'admin',
      title: 'Deactivate branch',
      breadcrumb: ['Admin', 'Branches', 'Deactivate'],
    },
    '/patient/recurring-cancel': {
      file: '../../mockups/33-recurring-occurrence-cancel.html',
      actor: 'patient',
      title: 'Cancel one occurrence',
      breadcrumb: ['Patient', 'Manage', 'Cancel one'],
    },
    '/conflict': {
      file: '../../mockups/29-conflict-modal.html',
      actor: 'landing',
      title: 'ConflictModal · universal pattern',
      breadcrumb: ['Design system', 'ConflictModal'],
    },
  };

  // ─── Display labels + group metadata for the quick-jump dropdown ──────
  const ROUTE_META = {
    '/':                          { num: '01',  flow: '—',  group: 'landing' },
    '/patient/doctor':            { num: '02',  flow: 'F-02', group: 'patient' },
    '/patient/slot':              { num: '03',  flow: 'F-02', group: 'patient' },
    '/patient/confirm':           { num: '04',  flow: 'F-03', group: 'patient' },
    '/patient/manage':            { num: '05',  flow: 'F-04/F-05', group: 'patient' },
    '/patient/recurring':         { num: '07',  flow: 'F-11', group: 'patient' },
    '/patient/branch':            { num: '34',  flow: 'F-01', group: 'patient' },
    '/patient/type':              { num: '35',  flow: 'F-01', group: 'patient' },
    '/patient/receipt':           { num: '36',  flow: 'F-01', group: 'patient' },
    '/patient/otp':               { num: '21',  flow: 'F-03', group: 'patient' },
    '/patient/cancel-confirm':    { num: '22',  flow: 'F-04', group: 'patient' },
    '/patient/reschedule':        { num: '20',  flow: 'F-05', group: 'patient' },
    '/patient/recurring-cancel':  { num: '33',  flow: 'E6-S4', group: 'patient' },
    '/doctor/schedule':           { num: '09',  flow: 'F-06', group: 'doctor' },
    '/doctor/block':              { num: '10',  flow: 'F-07', group: 'doctor' },
    '/doctor/types':              { num: '11',  flow: 'F-08', group: 'doctor' },
    '/doctor/today':              { num: '12',  flow: 'F-10', group: 'doctor' },
    '/doctor/resolve':            { num: '06',  flow: 'F-09', group: 'doctor' },
    '/doctor/recurring-preview':  { num: '23',  flow: 'F-11', group: 'doctor' },
    '/recurring/confirm':         { num: '23',  flow: 'F-11', group: 'doctor' },
    '/doctor/resolve-one':        { num: '24',  flow: 'F-09', group: 'doctor' },
    '/doctor/cancel-reason':      { num: '25',  flow: 'F-10', group: 'doctor' },
    '/doctor/audit-drawer':       { num: '30',  flow: 'UX',  group: 'doctor' },
    '/doctor/resolution-saved':   { num: '37',  flow: 'F-09', group: 'doctor' },
    '/recep/today':               { num: '13',  flow: 'F-12', group: 'recep' },
    '/recep/create':              { num: '14',  flow: 'F-13', group: 'recep' },
    '/recep/cancel':              { num: '15',  flow: 'F-14', group: 'recep' },
    '/recep/availability':        { num: '16',  flow: 'F-15', group: 'recep' },
    '/recep/checkin':             { num: '26',  flow: 'F-13', group: 'recep' },
    '/admin/branches':            { num: '17',  flow: 'F-16', group: 'admin' },
    '/admin/branch-hours':        { num: '08',  flow: 'F-17', group: 'admin' },
    '/admin/branch-hours-editor': { num: '28',  flow: 'F-17', group: 'admin' },
    '/admin/doctors':             { num: '18',  flow: 'F-18', group: 'admin' },
    '/admin/doctor-reassign':     { num: '31',  flow: 'F-18', group: 'admin' },
    '/admin/clinic':              { num: '32',  flow: 'E1-S0', group: 'admin' },
    '/admin/branch-deactivate':   { num: '38',  flow: 'F-21', group: 'admin' },
    '/admin/receptionists':       { num: '19',  flow: 'F-19', group: 'admin' },
    '/admin/audit':               { num: '27',  flow: 'F-20', group: 'admin' },
    '/admin/branch-new':          { num: '17n', flow: '—',  group: 'admin' },
    '/admin/doctor-edit':         { num: '18e', flow: '—',  group: 'admin' },
    '/admin/doctor-new':          { num: '18n', flow: '—',  group: 'admin' },
    '/admin/recep-edit':          { num: '19e', flow: '—',  group: 'admin' },
    '/admin/recep-assign':        { num: '19a', flow: '—',  group: 'admin' },
    '/admin/recep-new':           { num: '19n', flow: '—',  group: 'admin' },
    '/conflict':                  { num: '29',  flow: 'UX',  group: 'ds' },
  };

  const GROUP_ORDER = ['landing', 'patient', 'doctor', 'recep', 'admin'];
  const GROUP_LABEL = {
    landing: 'Landing',
    patient: 'Patient',
    doctor:  'Doctor',
    recep:   'Receptionist',
    admin:   'Admin',
  };

  // ─── Role → home route mapping ─────────────────────────────────────────
  const ROLE_HOMES = {
    landing: '/',
    patient: '/patient/doctor',
    doctor:  '/doctor/schedule',
    recep:   '/recep/today',
    admin:   '/admin/branches',
  };

  // ─── DOM refs ──────────────────────────────────────────────────────────
  const iframe       = document.getElementById('app-frame');
  const crumbsEl     = document.getElementById('crumbs');
  const roleSelect   = document.getElementById('roleSelect');
  const openInNew    = document.getElementById('openInNew');
  const loadingEl    = document.getElementById('loading');
  const notFoundEl   = document.getElementById('notfound');
  const notFoundHash = document.getElementById('notfoundHash');

  // ─── State ─────────────────────────────────────────────────────────────
  let currentActor = 'landing';
  let currentHash  = '/';
  let isNavigating = false;          // debounce rapid clicks

  // ─── Quick-jump dropdown population ────────────────────────────────────
  const quickJump     = document.getElementById('quickJump');
  const quickJumpBtn  = document.getElementById('quickJumpBtn');
  const quickJumpPanel = document.getElementById('quickJumpPanel');

  function buildQuickJump() {
    const byGroup = {};
    Object.keys(ROUTES).forEach(hash => {
      const meta = ROUTE_META[hash];
      if (!meta) return;
      (byGroup[meta.group] = byGroup[meta.group] || []).push({ hash, meta });
    });

    const html = GROUP_ORDER.filter(g => byGroup[g]).map(group => {
      const items = byGroup[group].map(({ hash, meta }) => {
        const r = ROUTES[hash];
        return `<a class="qj-link" href="#${hash}" data-hash="${hash}"><span class="num">${meta.num}</span><span class="label">${escapeHtml(r.title)}</span><span class="flow">${meta.flow}</span></a>`;
      }).join('');
      return `<div class="qj-group"><div class="qj-group-head"><span class="dot ${group}"></span>${GROUP_LABEL[group]}<span class="count">${byGroup[group].length}</span></div>${items}</div>`;
    }).join('');

    quickJumpPanel.innerHTML = html;
  }

  function setQuickJumpActive(hash) {
    quickJumpPanel.querySelectorAll('.qj-link').forEach(a => {
      a.classList.toggle('active', a.dataset.hash === hash);
    });
  }

  // Toggle dropdown
  quickJumpBtn.addEventListener('click', e => {
    e.stopPropagation();
    const open = quickJump.classList.toggle('open');
    quickJumpBtn.setAttribute('aria-expanded', String(open));
  });

  // Click outside closes
  document.addEventListener('click', e => {
    if (!quickJump.contains(e.target)) quickJump.classList.remove('open');
  });

  // Esc closes
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') quickJump.classList.remove('open');
  });

  buildQuickJump();

  // ─── Router ────────────────────────────────────────────────────────────
  function parseHash() {
    const raw = (location.hash || '#/').replace(/^#/, '');
    return raw || '/';
  }

  function navigate(hash) {
    if (!ROUTES[hash]) return;
    if (location.hash === '#' + hash) {
      // Same hash → re-render in place
      render(hash);
      return;
    }
    location.hash = hash;
  }

  function render(hash) {
    if (isNavigating) return;
    const route = ROUTES[hash];

    if (!route) {
      notFoundHash.textContent = '#' + hash;
      notFoundEl.classList.remove('hidden');
      iframe.style.display = 'none';
      loadingEl.classList.add('hidden');
      quickJump.classList.remove('open');
      return;
    }
    notFoundEl.classList.add('hidden');
    iframe.style.display = 'block';

    // Fade out + show spinner
    isNavigating = true;
    iframe.classList.add('fading');
    loadingEl.classList.remove('hidden');
    quickJump.classList.remove('open');

    currentActor = route.actor;
    currentHash  = hash;

    // Update chrome
    renderBreadcrumb(route.breadcrumb);
    roleSelect.value = route.actor;
    openInNew.href     = route.file;
    openInNew.title    = 'Open ' + route.title + ' in new tab';
    document.title     = route.title + ' · MediSlot';
    setQuickJumpActive(hash);

    // Slight delay to let the fade visibly play
    setTimeout(() => { iframe.src = route.file; }, 80);
  }

  function renderBreadcrumb(parts) {
    if (!parts || !parts.length) {
      crumbsEl.innerHTML = '';
      return;
    }
    const html = parts.map((p, i) => {
      const isLast = i === parts.length - 1;
      const cls = isLast ? 'crumb crumb-leaf' : 'crumb crumb-root';
      // Clicking a non-leaf crumb navigates to the corresponding home
      const target = isLast ? '' : routeForCrumb(i);
      const dataAttr = target ? ` data-route="${target}"` : '';
      return `<span class="${cls}"${dataAttr}>${escapeHtml(p)}</span>` + (isLast ? '' : '<span class="crumb-sep">›</span>');
    }).join('');
    crumbsEl.innerHTML = html;
  }

  // Map crumb index → hash: 0 = actor home, 1 = root, 2+ = leave leaf
  function routeForCrumb(idx) {
    if (idx === 0) return ROLE_HOMES[currentActor] || '/';
    if (idx === 1) return firstRouteForActor(currentActor);
    return null;
  }

  function firstRouteForActor(actor) {
    const hash = Object.keys(ROUTES).find(h => ROUTES[h].actor === actor && ROUTES[h].isHome);
    return hash || '/';
  }

  // Click handler for crumbs (delegated)
  crumbsEl.addEventListener('click', e => {
    const crumb = e.target.closest('.crumb[data-route]');
    if (!crumb) return;
    navigate(crumb.dataset.route);
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ─── Iframe onload: fade in + click-to-route wiring ────────────────────
  iframe.addEventListener('load', () => {
    isNavigating = false;
    loadingEl.classList.add('hidden');
    iframe.classList.remove('fading');

    let doc;
    try {
      doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
    } catch (e) {
      console.warn('[shell] cannot access iframe document (sandbox)', e);
      return;
    }
    if (!doc) return;

    // Hide demo badge
    try {
      const badge = doc.querySelector('.badge');
      if (badge) badge.style.display = 'none';
    } catch (_) {}

    // Make logos look clickable
    try {
      doc.querySelectorAll('.logo').forEach(el => { el.style.cursor = 'pointer'; });
    } catch (_) {}

    // Inject click listener that reads data-route
    const injection = `
      (function() {
        document.addEventListener('click', function(e) {
          let el = e.target;
          let depth = 0;
          while (el && depth < 8) {
            if (el.dataset && el.dataset.route !== undefined) {
              const route = el.dataset.route;
              if (route === '') return;
              if (route === '__logo__') {
                e.preventDefault();
                e.stopPropagation();
                try { parent.postMessage({ type: 'cc-navigate-logo' }, '*'); } catch (_) {}
                return;
              }
              if (route && route.charAt(0) === '/') {
                e.preventDefault();
                e.stopPropagation();
                try { parent.postMessage({ type: 'cc-navigate', hash: route }, '*'); } catch (_) {}
                return;
              }
            }
            el = el.parentElement;
            depth++;
          }
        }, true);
      })();
    `;

    try {
      const script = doc.createElement('script');
      script.textContent = injection;
      doc.body.appendChild(script);
      setTimeout(() => {
        try { doc.body.removeChild(script); } catch (_) {}
      }, 50);
    } catch (e) {
      console.warn('[shell] injection failed', e);
    }
  });

  // ─── Listen for navigation messages from iframe ────────────────────────
  window.addEventListener('message', (e) => {
    if (!e.data || !e.data.type) return;

    if (e.data.type === 'cc-navigate-logo') {
      const home = ROLE_HOMES[currentActor] || '/';
      navigate(home);
      return;
    }

    if (e.data.type === 'cc-navigate') {
      const hash = e.data.hash;
      if (hash && ROUTES[hash]) navigate(hash);
    }
  });

  // ─── Role select ───────────────────────────────────────────────────────
  roleSelect.addEventListener('change', () => {
    const role = roleSelect.value;
    const home = ROLE_HOMES[role];
    if (home) navigate(home);
  });

  // ─── Hashchange ────────────────────────────────────────────────────────
  window.addEventListener('hashchange', () => {
    render(parseHash());
  });

  // ─── Initial render ────────────────────────────────────────────────────
  const initial = parseHash();
  if (!location.hash) {
    history.replaceState(null, '', '#/');
  }
  render(initial);
})();
