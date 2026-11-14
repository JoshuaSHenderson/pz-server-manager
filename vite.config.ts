import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The SPA is built out of web/ into dist/, which is what Express serves. Keeping the source out of
// public/ matters: Vite treats a `public` directory as verbatim static assets, and the old
// single-file UI lived in exactly that path.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // Source maps in the build, because the only way anyone debugs this is with the browser open
    // against the box it runs on — there is no staging copy.
    sourcemap: true,
  },
  server: {
    port: 5173,
    // `npm run dev` serves the UI from Vite and forwards the API to a manager running elsewhere,
    // so the frontend can be iterated on without rebuilding the container.
    proxy: {
      '/api': {
        target: process.env.MANAGER_URL || 'http://localhost:7778',
        changeOrigin: true,
      },
    },
  },
})
