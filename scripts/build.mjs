import { build } from "esbuild";
import { cpSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

const entries = [
  
  
  { in: "src/background/service-worker.ts", out: "dist/background/service-worker.js", format: "esm" },
  
  
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
