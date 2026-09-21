/**
 * Build script for AWS Lambda deployment.
 *
 * Bundles lambda/forecast-handler.ts and lambda/history-handler.ts into
 * single .mjs files in dist/. Ported VERBATIM from Agent #1's pattern so
 * the bundler shape stays identical across the four agents.
 *
 * Usage:  npm run build
 * Output: dist/forecast-handler.mjs, dist/history-handler.mjs
 */

import esbuild from "esbuild";
import fs from "node:fs";

if (!fs.existsSync("./dist")) {
  fs.mkdirSync("./dist", { recursive: true });
}

const commonOptions = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["@aws-sdk/*"],
  sourcemap: true,
  minify: true,
  outExtension: { ".js": ".mjs" },
  // Banner: shim __dirname/__filename and require() for any CJS deps esbuild
  // pulled in. Without this, bundled CJS modules using require() crash.
  banner: {
    js: `import { fileURLToPath as __ef } from 'url';
import { dirname as __df } from 'path';
import { createRequire as __cr } from 'module';
const __filename = __ef(import.meta.url);
const __dirname = __df(__filename);
const require = __cr(import.meta.url);`,
  },
};

async function build() {
  try {
    await esbuild.build({
      ...commonOptions,
      entryPoints: ["./lambda/forecast-handler.ts"],
      outfile: "./dist/forecast-handler.mjs",
    });
    await esbuild.build({
      ...commonOptions,
      entryPoints: ["./lambda/history-handler.ts"],
      outfile: "./dist/history-handler.mjs",
    });

    const f = fs.statSync("./dist/forecast-handler.mjs").size;
    const h = fs.statSync("./dist/history-handler.mjs").size;
    console.log(`✓ forecast-handler.mjs: ${(f / 1024).toFixed(1)} KB`);
    console.log(`✓ history-handler.mjs:  ${(h / 1024).toFixed(1)} KB`);
    console.log(`Total bundle size: ${((f + h) / 1024).toFixed(1)} KB`);
  } catch (e) {
    console.error("Build failed:", e);
    process.exit(1);
  }
}

build();
