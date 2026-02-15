/**
 * Pre-bundle Remotion compositions for deployment.
 *
 * IMPORTANT: @remotion/bundler uses webpack internally.
 * Running it inside a Next.js API route causes a webpack-in-webpack conflict.
 * Always run this at build time, not at runtime.
 *
 * Usage: node scripts/build-remotion.mjs
 */

import { bundle } from "@remotion/bundler";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

console.log("Bundling Remotion compositions...");

const bundled = await bundle({
  entryPoint: path.resolve(rootDir, "src/remotion/index.ts"),
  outDir: path.resolve(rootDir, "remotion-build"),
});

console.log(`Bundle created at: ${bundled}`);
