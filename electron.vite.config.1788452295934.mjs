// electron.vite.config.ts
import { defineConfig } from "electron-vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
var __electron_vite_injected_dirname = "E:\\\u7384\u67A2AI\\xuanshu-ai-dev";
var electron_vite_config_default = defineConfig({
  main: {
    resolve: {
      alias: {
        "@": path.resolve(__electron_vite_injected_dirname, "src")
      }
    },
    build: {
      outDir: "out/main",
      target: "node20",
      lib: {
        entry: "src/main/index.ts",
        formats: ["cjs"]
      },
      rollupOptions: {
        external: ["ws", "bufferutil", "node-llama-cpp", "electron", "electron-updater", "lazy-val", "better-sqlite3", "playwright"]
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        "@": path.resolve(__electron_vite_injected_dirname, "src")
      }
    },
    build: {
      outDir: "out/preload",
      lib: {
        entry: "src/preload/index.ts",
        formats: ["cjs"]
      }
    }
  },
  renderer: {
    plugins: [
      react({
        jsxRuntime: "automatic",
        babel: {
          plugins: []
        }
      }),
      tailwindcss(),
      {
        name: "remove-crossorigin",
        enforce: "post",
        transformIndexHtml(html) {
          return html.replace(/\s+crossorigin(?:="[^"]*")?/gi, "");
        }
      }
    ],
    resolve: {
      alias: {
        "@": path.resolve(__electron_vite_injected_dirname, "src")
      },
      dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"]
    },
    optimizeDeps: {
      force: true,
      include: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "zustand", "zustand/middleware"]
    },
    css: {
      postcss: false
    },
    /** 灏嗛」鐩?assets/ 鐩綍浣滀负鍏叡璧勬簮鐩綍锛宒ev 鍜?build 鍧囩敓鏁?*/
    /** 强制监听 IPv4，解决 Electron 白屏问题 */
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true
    },
    publicDir: path.resolve(__electron_vite_injected_dirname, "assets"),
    build: {
      outDir: "out/renderer",
      emptyOutDir: true,
      minify: false,
      rollupOptions: {
        input: "src/renderer/index.html",
        output: {
          manualChunks: {
            "vendor-react": ["react", "react-dom", "react-router-dom"],
            "vendor-framer": ["framer-motion"],
            "vendor-icons": ["lucide-react"]
          }
        }
      }
    }
  }
});
export {
  electron_vite_config_default as default
};
