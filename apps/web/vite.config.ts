import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // Dev proxy: forward API paths to the running API process on :3001.
    // Eliminates CORS during local dev (the browser always sees
    // localhost:5173). Production builds do not use this — they go
    // through the same origin via the platform's reverse proxy.
    //
    // Every top-level API path prefix must be listed here. A prefix
    // that is missing is NOT proxied — Vite serves the request from
    // the SPA fallback, which answers 404 with an HTML body. The
    // client then surfaces it as `api_404:unknown_error`.
    //
    // `/recurring` was missing: `POST /recurring/preview` and
    // `POST /recurring/confirm` (E6-S1) 404'd, so the doctor's
    // recurring-series form could never preview a series.
    //
    // `/appointments` was missing for the same reason: the staff
    // mark-status and doctor-cancel routes are registered as
    // `/appointments/:id/mark-status` and `/appointments/:id/cancel`
    // (mounted bare, NOT under `/doctor`).
    proxy: {
      '/admin': 'http://localhost:3001',
      '/patient': 'http://localhost:3001',
      '/doctor': 'http://localhost:3001',
      '/reception': 'http://localhost:3001',
      '/recurring': 'http://localhost:3001',
      '/appointments': 'http://localhost:3001',
      '/availability': 'http://localhost:3001',
      '/bookings': 'http://localhost:3001',
      '/public': 'http://localhost:3001',
      '/staff-catalog': 'http://localhost:3001',
      '/auth': 'http://localhost:3001',
      '/health': 'http://localhost:3001',
      '/metrics': 'http://localhost:3001',
    },
  },
});
