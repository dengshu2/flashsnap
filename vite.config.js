import { defineConfig } from 'vite';

export default defineConfig({
    server: {
        host: '0.0.0.0',
        port: 5180,
    },
    build: {
        outDir: 'dist',
        // Use default esbuild minify (much faster than terser for large deps)
        minify: 'esbuild',
    },
});
