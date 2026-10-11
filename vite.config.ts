import { defineConfig } from 'vitest/config';
import { alphaTab } from '@coderline/alphatab-vite';

// GitHub Pages serves project sites from /<repo>/; the deploy workflow sets BASE_PATH.
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [
    // Bundles alphaTab's workers/worklets and copies the Bravura font and
    // SONiVOX soundfont into public/ (served at <base>font/ and <base>soundfont/).
    alphaTab(),
  ],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
