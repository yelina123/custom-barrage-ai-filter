import { resolve } from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig(({ mode }) => {
  const background = mode === "background";
  const popup = mode === "popup";

  return {
    plugins: background ? [] : [vue()],
    publicDir: background ? false : "public",
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    build: {
      outDir: "dist",
      emptyOutDir: !background && !popup,
      cssCodeSplit: false,
      minify: true,
      sourcemap: false,
      lib: {
        entry: resolve(
          process.cwd(),
          background ? "src/extension/background.ts" : popup ? "src/extension/popup.ts" : "src/extension/content.ts",
        ),
        name: background ? "SpoilerBarrageBackground" : popup ? "SpoilerBarragePopup" : "SpoilerBarrageContent",
        formats: ["iife"],
        fileName: () => (background ? "background.js" : popup ? "popup.js" : "content.js"),
      },
      rollupOptions: {
        output: {
          assetFileNames: (assetInfo) =>
            assetInfo.name?.endsWith(".css") ? (popup ? "popup.css" : "content.css") : "assets/[name][extname]",
        },
      },
    },
  };
});
