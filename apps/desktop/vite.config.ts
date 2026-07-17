import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri expects the dev server on a fixed port (see tauri.conf.json devUrl).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
