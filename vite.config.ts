import { defineConfig } from 'vitest/config';
import { alphaTab } from '@coderline/alphatab-vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves project sites from /<repo>/; the deploy workflow sets BASE_PATH.
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [
    // Bundles alphaTab's workers/worklets and copies the Bravura font and
    // SONiVOX soundfont into public/ (served at <base>font/ and <base>soundfont/).
    alphaTab(),
    VitePWA({
      registerType: 'autoUpdate',
      // Icons are already matched by workbox.globPatterns below.
      includeManifestIcons: false,
      manifest: {
        name: 'Guitar Trainer',
        short_name: 'Guitar Trainer',
        description: 'Practice guitar parts from Guitar Pro / MusicXML files with real-time microphone feedback.',
        theme_color: '#16181c',
        background_color: '#121418',
        display: 'standalone',
        orientation: 'any',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
        file_handlers: [
          {
            action: '.',
            accept: { 'application/octet-stream': ['.gp', '.gp3', '.gp4', '.gp5', '.gpx', '.mxl'], 'application/xml': ['.musicxml', '.xml'] },
          },
        ],
      },
      workbox: {
        // App shell + alphaTab workers + the WOFF2 music font + the soundfont,
        // so practicing works offline. Other font formats are fallbacks the
        // browser never requests.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,sf2}'],
        globIgnores: ['**/font/Bravura.svg', '**/icon-maskable.svg'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
    }),
  ],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
  },
  // alphaTab's worker/worklet and our detector worker are ES modules. The
  // alphaTab plugin bundles its worker and worklet itself and only minifies
  // them when asked to here.
  worker: {
    format: 'es',
    rolldownOptions: { output: { minify: true } },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
