import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // The copilot server (FastAPI) runs on 8000; the editor talks to it through /api.
    proxy: { '/api': 'http://127.0.0.1:8000' },
    fs: { allow: ['..'] },
  },
});
