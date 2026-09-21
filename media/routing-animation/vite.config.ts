import {defineConfig} from 'vite';
import motionCanvas from '@motion-canvas/vite-plugin';
import ffmpeg from '@motion-canvas/ffmpeg';

export default defineConfig({
  publicDir: '../../assets',
  // These Motion Canvas 3.x plugins expose their factory through CJS default.
  plugins: [motionCanvas.default(), ffmpeg.default()],
  // Editor plugins and scenes must share the same context/thread singletons.
  // Vite 6 otherwise prebundles extra copies through their dynamic entry points.
  optimizeDeps: {
    exclude: ['@motion-canvas/core', '@motion-canvas/2d', '@motion-canvas/ui'],
    // CommonJS dependencies still need Vite's ESM interop transform.
    include: [
      'chroma-js', 'parse-svg-path',
      'mathjax-full/js/adaptors/liteAdaptor', 'mathjax-full/js/handlers/html',
      'mathjax-full/js/input/tex', 'mathjax-full/js/input/tex/AllPackages',
      'mathjax-full/js/mathjax', 'mathjax-full/js/output/svg',
    ],
  },
  server: {fs: {allow: ['../..']}},
});
