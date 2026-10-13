import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// When deploying to https://<user>.github.io/hmail/ the build needs base: '/hmail/'.
// When deploying to a custom domain (mail.hyphae.social) base stays '/'.
// VITE_BASE_PATH overrides at build time; default is '/' so `npm run dev` works
// without thinking about it.
//
// Four HTML entry points: the public landing page (/), the app (/app/), and the
// static privacy policy (/privacy/) and terms (/terms/) that Google's OAuth
// verification requires to be real pages, not the login shell.
export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? "/",
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        app: path.resolve(__dirname, "app/index.html"),
        privacy: path.resolve(__dirname, "privacy/index.html"),
        terms: path.resolve(__dirname, "terms/index.html"),
      },
    },
  },
  plugins: [
    react(),
    {
      // The Matrix Rust-crypto loader fetches its .wasm and hands it to
      // WebAssembly.compileStreaming, which refuses anything whose
      // Content-Type isn't exactly `application/wasm`. The dev server serves
      // node_modules files under /@fs/ with a generic type, so pin it here.
      name: "wasm-mime",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url && req.url.split("?")[0].endsWith(".wasm")) {
            res.setHeader("Content-Type", "application/wasm");
          }
          next();
        });
      },
      configurePreviewServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url && req.url.split("?")[0].endsWith(".wasm")) {
            res.setHeader("Content-Type", "application/wasm");
          }
          next();
        });
      },
    },
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  optimizeDeps: {
    // The crypto package resolves its .wasm via
    // `new URL("./pkg/…wasm", import.meta.url)`. Pre-bundling rewrites that
    // URL, so the fetch 404s and Vite's SPA fallback answers with HTML —
    // which WebAssembly.instantiateStreaming rejects (MIME type). Excluding
    // it keeps import.meta.url pointing at the real file in node_modules.
    exclude: ["@matrix-org/matrix-sdk-crypto-wasm"],
  },
  server: {
    port: 5173,
  },
});
