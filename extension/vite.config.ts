import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import path from 'node:path';
import manifest from './manifest.config';

export default defineConfig({
  plugins: [crx({ manifest })],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    target: 'esnext',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    globals: true,
  },
});
