import { build } from "esbuild";
import { cpSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

const entries = [
  { in: "src/content/content-script.ts",    out: "dist/content/content-script.js",    format: "iife" },
  { in: "src/content/page-script.ts",       out: "dist/content/page-script.js",       format: "iife" },
  { in: "src/background/service-worker.ts", out: "dist/background/service-worker.js", format: "esm" },
  { in: "src/options/options.ts",           out: "dist/options/options.js",           format: "esm" },
  { in: "src/offscreen/offscreen.ts",       out: "dist/offscreen/offscreen.js",       format: "iife" },
];

for (const e of entries) {
  await build({
    entryPoints: [e.in],
    bundle: true,
    outfile: e.out,
    format: e.format,
    target: "es2022",
    platform: "browser",
    logLevel: "info",
  });
}

cpSync("public", "dist", { recursive: true });
console.log("build done");
