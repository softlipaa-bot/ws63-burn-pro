import path from "path";
import vue from "@vitejs/plugin-vue";
import ui from "@nuxt/ui/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    vue(),
    ui({
      ui: {
        colors: {
          primary: "brand",
          neutral: "slate",
        },
      },
    }),
    {
      name: "electron-html",
      transformIndexHtml(html) {
        return html
          .replace(/\s*crossorigin/g, "")
          .replace(/<script type="module"/g, "<script defer");
      },
    },
  ],
  base: "./",
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: { port: 5173, strictPort: true },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    modulePreload: false,
    cssCodeSplit: false,
    target: "chrome120",
    rollupOptions: {
      output: {
        format: "iife",
        name: "Ws63BurnApp",
        inlineDynamicImports: true,
        entryFileNames: "assets/app.js",
        assetFileNames: "assets/app.[ext]",
      },
    },
  },
});
