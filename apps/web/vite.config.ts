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
    proxy: {
      '/admin': 'http://localhost:3001',
      '/patient': 'http://localhost:3001',
      '/availability': 'http://localhost:3001',
      '/bookings': 'http://localhost:3001',
      '/health': 'http://localhost:3001',
      '/metrics': 'http://localhost:3001',
    },
  },
});
