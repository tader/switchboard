import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const target = process.env.SWITCHBOARD_DEV_API ?? 'http://localhost:8770';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': target, '/oauth': target, '/proxy': target },
  },
});
