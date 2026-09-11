import { defineConfig } from 'electron-vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src')
      }
    },
    build: {
      outDir: 'out/main',
      target: 'node20',
      lib: {
        entry: 'src/main/index.ts',
        formats: ['cjs']
      },
      rollupOptions: {
        external: ['ws', 'bufferutil', 'node-llama-cpp', 'electron', 'electron-updater', 'lazy-val', 'better-sqlite3', 'playwright']
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src')
      }
    },
    build: {
      outDir: 'out/preload',
      lib: {
        entry: 'src/preload/index.ts',
        formats: ['cjs']
      }
    }
  },
  renderer: {
    plugins: [
      react({
        jsxRuntime: 'automatic',
        babel: {
          plugins: []
        }
      }),
      tailwindcss(),
      {
        name: 'remove-crossorigin',
        enforce: 'post',
        transformIndexHtml(html: string): string {
          return html.replace(/\s+crossorigin(?:="[^"]*")?/gi, '')
        }
      }
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src')
      },
      dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime']
    },
    optimizeDeps: {
      force: true,
      include: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'zustand', 'zustand/middleware']
    },
    css: {
      postcss: false
    },
    /** 将项目 assets/ 目录作为公共资源目录，dev 和 build 均生效 */
    publicDir: path.resolve(__dirname, 'assets'),
    build: {
      outDir: 'out/renderer',
      emptyOutDir: true,
      minify: false,
      rollupOptions: {
        input: 'src/renderer/index.html',
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            'vendor-framer': ['framer-motion'],
            'vendor-icons': ['lucide-react'],
          }
        }
      }
    }
  }
})
