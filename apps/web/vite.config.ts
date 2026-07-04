import { defineConfig } from 'vite';

// The World page is a pure read-model client (ADR-0013): it only consumes the API's SSE stream.
// The dev server proxies the read endpoints to the API process.
const API = process.env.LATEO_API_URL ?? 'http://127.0.0.1:3900';

export default defineConfig({
  server: {
    proxy: {
      '/world': { target: API, changeOrigin: true },
      '/creatures': { target: API, changeOrigin: true },
    },
  },
});
