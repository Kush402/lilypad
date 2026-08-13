import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5176, strictPort: true },
  // Fixed, because the cloudflared ingress for lilypadhome.takedia.com points
  // at this exact port (infra/cloudflared/lilypad.yml). A port that moved would
  // silently 502 the public hostname.
  preview: {
    port: 4173,
    strictPort: true,
    // Bind every interface, not just IPv6 localhost (vite's default). cloudflared
    // dials `localhost`, which resolves to ::1 first and happens to work, but a
    // health check or a phone on the LAN hitting the IPv4 address would find
    // nothing listening — a confusing way to conclude the site is down.
    host: true,
    allowedHosts: ['lilypadhome.takedia.com'],
  },
  build: { target: 'es2022', outDir: 'dist' },
});
