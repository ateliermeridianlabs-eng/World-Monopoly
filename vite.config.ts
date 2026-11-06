import { defineConfig } from 'vite';

// assets/ is served as the public root, so assets/cities/x.webp loads from ./cities/x.webp.
// base './' keeps the build working from any sub-path (GitHub Pages, itch.io, a local file server).
export default defineConfig({
  base: './',
  publicDir: 'assets',
});
