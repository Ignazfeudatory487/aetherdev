import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env['VITE_API_URL'] ?? 'http://localhost:3001',
        changeOrigin: true,
      },
      '/ws': {
        target: process.env['VITE_WS_URL'] ?? 'ws://localhost:3001',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          ui: ['lucide-react', 'framer-motion'],
          charts: ['recharts'],
        },
      },
    },
  },
});
