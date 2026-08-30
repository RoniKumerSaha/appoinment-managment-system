/* MediSlot app shell â€” hash router + role switcher + click-to-route wiring
 *
 * All 19 winner mockups are loaded into a single iframe.
 * Each mockup has data-route attributes on its clickable elements
 * (button / a / .logo). The injection script below reads those
 * attributes and routes accordingly.
 *
 * Path resolution: this file lives at docs/mockups/v1/app/, so `../partNN-â€¦`
 * resolves to docs/mockups/v1/partNN-â€¦ which is where each winner sits.
 */

(function () {
  'use strict';

  // â”€â”€â”€ Route table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Each entry maps a hash to { file, actor, title, breadcrumb, isHome }
  // file is relative to docs/mockups/v1/app/index.html â†’ use ../ prefix.
  const ROUTES = {
    '/': {
      file: '../winners/01-layout-direction.html',
      actor: 'landing',
      title: 'Landing Â· Find your doctor',
      breadcrumb: ['Landing'],
      isHome: true,
    },

    // Patient
    '/patient/doctor': {
      file: '../winners/02-doctor-picker.html',
      actor: 'patient',
      title: 'Choose a branch & appointment type',
      breadcrumb: ['Patient', 'Choose a branch & type'],
      isHome: true,
    },
    '/patient/slot': {
      file: '../winners/03-availability-calendar.html',
      actor: 'patient',
      title: 'Pick a date and time',
      breadcrumb: ['Patient', 'Pick a date and time'],
    },
    '/patient/confirm': {
      file: '../winners/04-patient-confirm.html',
      actor: 'patient',
      title: 'Confirm your booking',
      breadcrumb: ['Patient', 'Confirm your booking'],
    },
    '/patient/manage': {
      file: '../winners/05-patient-self-service.html',
      actor: 'patient',
      title: 'Manage your appointments',
      breadcrumb: ['Patient', 'Manage your appointments'],
      isHome: true,
    },
    '/patient/recurring': {
      file: '../winners/07-recurring-preview.html',
      actor: 'patient',
      title: 'Recurring series preview',
      breadcrumb: ['Patient', 'Recurring series'],
    },

    // Doctor
    '/doctor/schedule': {
      file: '../winners/09-doctor-schedule.html',
      actor: 'doctor',
      title: 'Manage weekly schedule',
      breadcrumb: ['Doctor', 'Weekly schedule'],
      isHome: true,
    },
    '/doctor/block': {
      file: '../winners/10-doctor-block-time.html',
      actor: 'doctor',
      title: 'Block time off',
      breadcrumb: ['Doctor', 'Block time off'],
    },
    '/doctor/types': {
      file: '../winners/11-appointment-types.html',
      actor: 'doctor',
      title: 'Manage appointment types',
      breadcrumb: ['Doctor', 'Appointment types'],
    },
    '/doctor/today': {
      file: '../winners/12-mark-status.html',
      actor: 'doctor',
      title: 'Today Â· Mark status',
      breadcrumb: ['Doctor', "Today's list"],
    },
    '/doctor/resolve': {
      file: '../winners/06-resolve-affected.html',
      actor: 'doctor',
      title: 'Resolve affected appointments',
      breadcrumb: ['Doctor', 'Resolve affected'],
    },
    '/doctor/recurring-preview': {
      file: '../winners/07-recurring-preview.html',
      actor: 'doctor',
      title: 'Preview recurring series',
      breadcrumb: ['Doctor', 'Recurring preview'],
    },

    // Receptionist
    '/recep/today': {
      file: '../winners/13-recep-today.html',
      actor: 'recep',
      title: "Today's branch view",
      breadcrumb: ['Receptionist', "Today's view"],
      isHome: true,
    },
    '/recep/create': {
      file: '../winners/14-recep-create.html',
      actor: 'recep',
      title: 'Book on behalf of patient',
      breadcrumb: ['Receptionist', 'Book on behalf'],
    },
    '/recep/cancel': {
      file: '../winners/15-recep-cancel.html',
      actor: 'recep',
      title: 'Cancel an appointment',
      breadcrumb: ['Receptionist', 'Cancel appointment'],
    },
    '/recep/availability': {
      file: '../winners/16-recep-availability.html',
      actor: 'recep',
      title: 'Doctor availability Â· read-only',
      breadcrumb: ['Receptionist', 'Doctor availability'],
    },

    // Admin
    '/admin/branches': {
      file: '../winners/17-admin-branches.html',
      actor: 'admin',
      title: 'Manage branches',
      breadcrumb: ['Admin', 'Branches'],
      isHome: true,
    },
    '/admin/branch-hours': {
      file: '../winners/08-branch-hours-impact.html',
      actor: 'admin',
      title: 'Branch hours change impact',
      breadcrumb: ['Admin', 'Branch hours Â· impact'],
    },
    '/admin/doctors': {
      file: '../winners/18-admin-doctors.html',
      actor: 'admin',
      title: 'Manage doctors',
      breadcrumb: ['Admin', 'Doctors'],
    },
    '/admin/receptionists': {
      file: '../winners/19-admin-receptionists.html',
      actor: 'admin',
      title: 'Manage receptionists',
      breadcrumb: ['Admin', 'Receptionists'],
    },
  };

  // â”€â”€â”€ Role â†’ home route mapping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const ROLE_HOMES = {
    landing: '/',
    patient: '/patient/doctor',
    doctor: '/doctor/schedule',
    recep: '/recep/today',
    admin: '/admin/branches',
  };

  // â”€â”€â”€ DOM refs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const iframe = document.getElementById('app-frame');
  const crumbsEl = document.getElementById('crumbs');
  const roleSelect = document.getElementById('roleSelect');
  const openInNew = document.getElementById('openInNew');
  const loadingEl = document.getElementById('loading');
  const notFoundEl = document.getElementById('notfound');
  const notFoundHashEl = document.getElementById('notfoundHash');

  // â”€â”€â”€ Current actor (updated in render()) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let currentActor = 'landing';

  // â”€â”€â”€ Renderer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function parseHash() {
    const raw = (location.hash || '#/').replace(/^#/, '');
    return raw || '/';
  }

  function navigate(hash, opts) {
    opts = opts || {};
    if (!opts.silent && location.hash === '#' + hash) {
      render(hash);
      return;
    }
    if (!opts.silent) location.hash = hash;
    else render(hash);
  }

  function render(hash) {
    const route = ROUTES[hash];
    if (!route) {
      notFoundHashEl.textContent = '#' + hash;
      notFoundEl.classList.remove('hidden');
      iframe.style.display = 'none';
      loadingEl.classList.add('hidden');
      return;
    }
    notFoundEl.classList.add('hidden');
    iframe.style.display = 'block';

    loadingEl.classList.remove('hidden');

    currentActor = route.actor;
    iframe.src = route.file;
    openInNew.href = route.file;
    openInNew.title = 'Open ' + route.title + ' in new tab';

    renderBreadcrumb(route.breadcrumb, route.actor);
    roleSelect.value = route.actor;
  }

  function renderBreadcrumb(parts, actor) {
    if (!parts || !parts.length) {
      crumbsEl.innerHTML = '';
      return;
    }
    const html = parts.map((p, i) => {
      const isLast = i === parts.length - 1;
      const cls = isLast ? 'crumb crumb-leaf' : 'crumb crumb-root';
      return `<span class="${cls}">${escapeHtml(p)}</span>` + (isLast ? '' : '<span class="crumb-sep">â€º</span>');
    }).join('');
    crumbsEl.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // â”€â”€â”€ Iframe onload: inject click-to-route wiring â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Strategy: each clickable element in the mockup has a data-route attribute
  // pointing to the target hash. We listen on capture so we intercept clicks
  // before any default behavior, read the attribute, and post a message.
  iframe.addEventListener('load', () => {
    loadingEl.classList.add('hidden');

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
            // Direct data-route attribute on the element
            if (el.dataset && el.dataset.route !== undefined) {
              const route = el.dataset.route;
              if (route === '') return; // explicitly inert
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

  // â”€â”€â”€ Listen for navigation messages from iframe â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  window.addEventListener('message', (e) => {
    if (!e.data || !e.data.type) return;

    // Logo click â†’ route to current actor's home
    if (e.data.type === 'cc-navigate-logo') {
      const home = ROLE_HOMES[currentActor] || '/';
      navigate(home);
      return;
    }

    // Direct route click
    if (e.data.type === 'cc-navigate') {
      const hash = e.data.hash;
      if (hash && ROUTES[hash]) {
        navigate(hash);
      }
    }
  });

  // â”€â”€â”€ Role select â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  roleSelect.addEventListener('change', () => {
    const role = roleSelect.value;
    const home = ROLE_HOMES[role];
    if (home) navigate(home);
  });

  // â”€â”€â”€ Router: react to hashchange â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  window.addEventListener('hashchange', () => {
    render(parseHash());
  });

  // â”€â”€â”€ Initial render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const initial = parseHash();
  if (!location.hash) {
    history.replaceState(null, '', '#/');
  }
  render(initial);
})();
