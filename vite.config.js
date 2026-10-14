import { defineConfig } from "vite";
export default defineConfig({
  root: "ui",
  base: "/",
  build: { assetsDir: "static", outDir: "../dist", emptyOutDir: true },
});
