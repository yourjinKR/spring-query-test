import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(
      ['/v1', '/v2', '/lab', '/actuator'].map((path) => [path, {
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:8080',
        changeOrigin: true,
      }]),
    ),
  },
});
