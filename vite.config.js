import { defineConfig } from "vite";
import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const CLASSIC_SCRIPTS = [
  "schema.js",
  "schema-loader.js",
  "query-parser.js",
  "app.js",
];

/**
 * Local `npm run dev` uses `/`.
 * GitHub Pages project site is served under `/dql-builder/`.
 *
 * The app still loads classic (non-module) scripts, so Vite does not bundle
 * them — this plugin copies them into `dist/` next to index.html.
 */
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/dql-builder/" : "/",
  server: {
    open: true,
    port: 5173,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  plugins: [
    {
      name: "copy-classic-scripts",
      closeBundle() {
        const outDir = resolve("dist");
        for (const file of CLASSIC_SCRIPTS) {
          if (!existsSync(file)) {
            throw new Error(`Missing ${file} — cannot finish production build`);
          }
          cpSync(file, resolve(outDir, file));
        }
      },
    },
  ],
}));
