import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'static',
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('elkjs')) return 'layout';
        },
      },
    },
  },
});
