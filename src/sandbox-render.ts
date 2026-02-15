/**
 * Complete example: Remotion video rendering inside Vercel Sandbox.
 *
 * This file demonstrates how to:
 * 1. Create a Vercel Sandbox with all dependencies
 * 2. Patch the GNU compositor for glibc 2.35 compatibility
 * 3. Render a Remotion composition to MP4
 * 4. Use snapshots for fast subsequent renders
 *
 * Adapt this to your own project — the sandbox setup logic is the important part.
 */

import fs from "fs/promises";
import path from "path";
import { Sandbox } from "@vercel/sandbox";

// ── Configuration ────────────────────────────────────────────────────────────

const REMOTION_VERSION = "4.0.421";
const COMPOSITOR_DIR = "/vercel/sandbox/gnu-compositor";
const GLIBC_DIR = "/opt/glibc235";
const BUNDLE_DIR = "remotion-build"; // Pre-built Remotion bundle directory

// Chromium system dependencies (required for headless rendering)
const SYSTEM_DEPS = [
  "nss", "atk", "at-spi2-atk", "cups-libs", "libdrm",
  "libXcomposite", "libXdamage", "libXrandr", "mesa-libgbm",
  "alsa-lib", "pango", "gtk3",
];

// ── Render Script (runs inside the sandbox VM) ───────────────────────────────

const RENDER_SCRIPT = `
import { selectComposition, renderMedia, ensureBrowser } from "@remotion/renderer";
import { readFileSync, statSync } from "fs";

const config = JSON.parse(process.argv[2]);

async function main() {
  await ensureBrowser();

  const composition = await selectComposition({
    serveUrl: config.serveUrl,
    id: config.compositionId,
    inputProps: config.inputProps,
    binariesDirectory: config.compositorDir,
  });

  await renderMedia({
    composition,
    serveUrl: config.serveUrl,
    codec: "h264",
    outputLocation: config.outputPath,
    inputProps: config.inputProps,
    crf: config.crf ?? 23,
    binariesDirectory: config.compositorDir,
  });

  const stat = statSync(config.outputPath);
  const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
  console.log("Output file size: " + sizeMB + " MB");

  // Upload result (adapt this to your storage provider)
  if (config.uploadUrl) {
    const fileBuffer = readFileSync(config.outputPath);
    const res = await fetch(config.uploadUrl, {
      method: "POST",
      headers: {
        "Content-Type": "video/mp4",
        // Add your auth headers here
        ...(config.uploadHeaders || {}),
      },
      body: fileBuffer,
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error("Upload failed (" + res.status + "): " + errorBody);
    }
  }

  console.log(JSON.stringify({ success: true, sizeMB: parseFloat(sizeMB) }));
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
`.trim();

// ── Sandbox Setup ────────────────────────────────────────────────────────────

/**
 * Create a fresh sandbox with all dependencies installed.
 * This takes 3-5 minutes on first run, but snapshots make subsequent runs < 5s.
 */
async function createFreshSandbox(): Promise<Sandbox> {
  console.log("[Remotion] Creating fresh sandbox...");

  const sandbox = await Sandbox.create({
    runtime: "node24",
    resources: { vcpus: 8 },
    timeout: 15 * 60 * 1000,
  });

  // 1. ESM support
  await sandbox.writeFiles([{
    path: "package.json",
    content: Buffer.from(JSON.stringify({ type: "module", private: true })),
  }]);

  // 2. System dependencies (Chromium needs these)
  console.log("[Remotion] Installing system deps...");
  const dnfResult = await sandbox.runCommand({
    cmd: "dnf",
    args: ["install", "-y", ...SYSTEM_DEPS],
    sudo: true,
    signal: AbortSignal.timeout(2 * 60 * 1000),
  });
  if (dnfResult.exitCode !== 0) {
    const stderr = await dnfResult.stderr();
    console.warn(`[Remotion] dnf warning: ${stderr}`);
  }

  // 3. Copy pre-built Remotion bundle
  console.log("[Remotion] Copying bundle...");
  await copyBundleToSandbox(sandbox);

  // 4. JS dependencies
  console.log("[Remotion] Installing JS deps...");
  const npmResult = await sandbox.runCommand({
    cmd: "npm",
    args: ["install", "--save",
      `@remotion/renderer@${REMOTION_VERSION}`,
      `remotion@${REMOTION_VERSION}`,
    ],
    signal: AbortSignal.timeout(2 * 60 * 1000),
  });
  if (npmResult.exitCode !== 0) {
    const stderr = await npmResult.stderr();
    throw new Error(`[Remotion] npm install failed: ${stderr}`);
  }

  // 5. Custom glibc 2.35 (THE KEY FIX)
  //    AL2023 has glibc 2.34, but Remotion's compositor needs 2.35.
  //    We download Ubuntu 22.04's glibc as a portable library set.
  console.log("[Remotion] Installing custom glibc 2.35...");
  const glibcResult = await sandbox.runCommand({
    cmd: "bash",
    args: ["-c", [
      "set -e",
      "dnf install -y binutils patchelf zstd >/dev/null 2>&1",
      `mkdir -p "${GLIBC_DIR}"`,
      "cd /tmp",
      'curl -fL "http://launchpadlibrarian.net/612471225/libc6_2.35-0ubuntu3.1_amd64.deb" -o libc6.deb',
      "ar x libc6.deb",
      `tar xf data.tar.* -C "${GLIBC_DIR}"`,
    ].join(" && ")],
    sudo: true,
    signal: AbortSignal.timeout(2 * 60 * 1000),
  });
  if (glibcResult.exitCode !== 0) {
    const stderr = await glibcResult.stderr();
    throw new Error(`[Remotion] glibc 2.35 install failed: ${stderr}`);
  }

  // 6. GNU compositor (download from npm registry)
  console.log("[Remotion] Downloading GNU compositor...");
  const gnuTarball = `https://registry.npmjs.org/@remotion/compositor-linux-x64-gnu/-/compositor-linux-x64-gnu-${REMOTION_VERSION}.tgz`;
  const gnuResult = await sandbox.runCommand({
    cmd: "bash",
    args: ["-c", [
      "set -e",
      `mkdir -p "${COMPOSITOR_DIR}"`,
      `curl -sfL "${gnuTarball}" | tar xzf - -C "${COMPOSITOR_DIR}" --strip-components=1`,
      `chmod +x "${COMPOSITOR_DIR}/ffmpeg" "${COMPOSITOR_DIR}/ffprobe" "${COMPOSITOR_DIR}/remotion"`,
    ].join(" && ")],
    signal: AbortSignal.timeout(2 * 60 * 1000),
  });
  if (gnuResult.exitCode !== 0) {
    const stderr = await gnuResult.stderr();
    throw new Error(`[Remotion] GNU compositor download failed: ${stderr}`);
  }

  // 7. Patch remotion binary (THE CRITICAL STEP)
  //    - Set interpreter to glibc 2.35's dynamic linker
  //    - Set DT_RPATH (NOT DT_RUNPATH!) for transitive dependency resolution
  //    - --force-rpath is REQUIRED: without it, libswresample.so (loaded transitively
  //      via libavformat.so) won't be found
  console.log("[Remotion] Patching compositor for glibc 2.35...");
  const patchResult = await sandbox.runCommand({
    cmd: "bash",
    args: ["-c", [
      "set -e",
      `COMP="${COMPOSITOR_DIR}"`,
      `patchelf --set-interpreter "${GLIBC_DIR}/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2" "$COMP/remotion"`,
      `patchelf --force-rpath --set-rpath '$ORIGIN:${GLIBC_DIR}/lib/x86_64-linux-gnu:/lib64:/usr/lib64' "$COMP/remotion"`,
    ].join(" && ")],
    signal: AbortSignal.timeout(30 * 1000),
  });
  if (patchResult.exitCode !== 0) {
    const stderr = await patchResult.stderr();
    throw new Error(`[Remotion] patchelf failed: ${stderr}`);
  }

  // 8. Verify ffmpeg/ffprobe work
  const verifyResult = await sandbox.runCommand({
    cmd: "bash",
    args: ["-c", `"${COMPOSITOR_DIR}/ffmpeg" -version | head -1`],
    signal: AbortSignal.timeout(10 * 1000),
  });
  if (verifyResult.exitCode !== 0) {
    throw new Error("[Remotion] FFmpeg verification failed");
  }
  const ffmpegVersion = await verifyResult.stdout();
  console.log(`[Remotion] FFmpeg OK: ${ffmpegVersion.trim()}`);

  // 9. Install browser (Chromium)
  console.log("[Remotion] Installing browser...");
  await sandbox.writeFiles([{
    path: "ensure-browser.mts",
    content: Buffer.from([
      'import { ensureBrowser } from "@remotion/renderer";',
      "await ensureBrowser();",
    ].join("\n")),
  }]);
  await sandbox.runCommand({
    cmd: "node",
    args: ["--strip-types", "ensure-browser.mts"],
    signal: AbortSignal.timeout(3 * 60 * 1000),
  });

  // 10. Write render script
  await sandbox.writeFiles([{
    path: "render.mts",
    content: Buffer.from(RENDER_SCRIPT),
  }]);

  console.log("[Remotion] Sandbox ready!");
  return sandbox;
}

// ── Snapshot Management ──────────────────────────────────────────────────────

/**
 * Take a snapshot for fast future restores.
 * NOTE: snapshot() STOPS the sandbox — you must restore from it.
 */
async function snapshotAndRestore(sandbox: Sandbox): Promise<Sandbox> {
  console.log("[Remotion] Taking snapshot...");
  const snapshot = await sandbox.snapshot();
  const snapshotId = snapshot.snapshotId;
  console.log(`[Remotion] Snapshot ID: ${snapshotId}`);

  // Store this ID somewhere persistent (database, storage, etc.)
  // await saveSnapshotId(snapshotId);

  // Original sandbox is stopped — restore immediately
  const restored = await Sandbox.create({
    source: { type: "snapshot", snapshotId },
    runtime: "node24",
    resources: { vcpus: 8 },
    timeout: 15 * 60 * 1000,
  });

  console.log("[Remotion] Restored from snapshot");
  return restored;
}

/**
 * Restore from a previously saved snapshot ID.
 * Returns null if restore fails.
 */
async function restoreFromSnapshot(snapshotId: string): Promise<Sandbox | null> {
  try {
    console.log(`[Remotion] Restoring snapshot: ${snapshotId}`);
    const sandbox = await Sandbox.create({
      source: { type: "snapshot", snapshotId },
      runtime: "node24",
      resources: { vcpus: 8 },
      timeout: 15 * 60 * 1000,
    });

    // Always overwrite render script — snapshot may contain older version
    await sandbox.writeFiles([{
      path: "render.mts",
      content: Buffer.from(RENDER_SCRIPT),
    }]);

    return sandbox;
  } catch (err) {
    console.warn("[Remotion] Snapshot restore failed:", err);
    return null;
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────

interface RenderOptions {
  compositionId: string;
  inputProps: Record<string, unknown>;
  outputPath?: string;
  crf?: number;
  uploadUrl?: string;
  uploadHeaders?: Record<string, string>;
}

/**
 * Render a Remotion composition inside the sandbox.
 */
async function render(sandbox: Sandbox, options: RenderOptions): Promise<{ sizeMB: number }> {
  const config = {
    compositionId: options.compositionId,
    inputProps: options.inputProps,
    serveUrl: `/vercel/sandbox/${BUNDLE_DIR}`,
    outputPath: options.outputPath || `/tmp/output-${Date.now()}.mp4`,
    crf: options.crf ?? 23,
    compositorDir: COMPOSITOR_DIR,
    uploadUrl: options.uploadUrl,
    uploadHeaders: options.uploadHeaders,
  };

  console.log(`[Remotion] Rendering ${config.compositionId} (CRF ${config.crf})...`);

  const result = await sandbox.runCommand({
    cmd: "node",
    args: ["--strip-types", "render.mts", JSON.stringify(config)],
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });

  if (result.exitCode !== 0) {
    const stderr = await result.stderr();
    throw new Error(`Render failed: ${stderr}`);
  }

  const stdout = await result.stdout();
  const lines = stdout.trim().split("\n");
  const lastLine = lines[lines.length - 1];
  const parsed = JSON.parse(lastLine);

  if (!parsed.success) {
    throw new Error(parsed.error || "Unknown render error");
  }

  console.log(`[Remotion] Render complete (${parsed.sizeMB} MB)`);
  return { sizeMB: parsed.sizeMB };
}

// ── Helper: Copy Bundle ──────────────────────────────────────────────────────

async function copyBundleToSandbox(sandbox: Sandbox): Promise<void> {
  const bundlePath = path.join(process.cwd(), BUNDLE_DIR);
  const files: { path: string; content: Buffer }[] = [];

  async function readDir(dir: string, prefix: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const sandboxPath = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await readDir(fullPath, sandboxPath);
      } else {
        files.push({
          path: sandboxPath,
          content: await fs.readFile(fullPath),
        });
      }
    }
  }

  await readDir(bundlePath, BUNDLE_DIR);
  await sandbox.writeFiles(files);
}

// ── Usage Example ────────────────────────────────────────────────────────────

export async function example() {
  // Option A: Create fresh (first time, ~3-5 min)
  let sandbox = await createFreshSandbox();
  sandbox = await snapshotAndRestore(sandbox);

  // Option B: Restore from snapshot (subsequent runs, ~5 sec)
  // const sandbox = await restoreFromSnapshot("your-saved-snapshot-id");

  // Render
  const result = await render(sandbox, {
    compositionId: "MyComposition",
    inputProps: {
      title: "Hello World",
      // ... your composition props
    },
    crf: 23,
    // Optional: upload directly from sandbox
    // uploadUrl: "https://your-storage.com/upload/path",
    // uploadHeaders: { Authorization: "Bearer ..." },
  });

  console.log(`Video rendered: ${result.sizeMB} MB`);
}
