import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5176, strictPort: true },
  build: { target: 'es2022', outDir: 'dist' },
});
