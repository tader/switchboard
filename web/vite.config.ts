import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const target = process.env.SWITCHBOARD_DEV_API ?? 'http://localhost:8770';
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export default defineConfig({
  define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(version) },
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': target, '/oauth': target, '/proxy': target },
  },
});
