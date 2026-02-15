# Remotion Video Rendering in Vercel Sandbox

> How we spent **28 hours** debugging a glibc version mismatch, tried **10 different approaches**, bumped through **13 snapshot versions**, and finally got [Remotion](https://remotion.dev) rendering frame-accurate video inside [Vercel Sandbox](https://vercel.com/docs/functions/sandbox).

**TL;DR**: Vercel Sandbox runs Amazon Linux 2023 (glibc 2.34). Remotion's compositor needs glibc 2.35. The fix: download Ubuntu 22.04's glibc 2.35, use `patchelf --force-rpath` to patch the compositor binary. [Jump to the solution](#the-solution).

## Quick Start

```bash
git clone https://github.com/diojen-tech/remotion-vercel-sandbox.git
cd remotion-vercel-sandbox
npm install
npm run build:remotion   # Pre-bundle the example Remotion composition
```

The repo includes:
- **[`src/sandbox-render.ts`](src/sandbox-render.ts)** — Complete sandbox setup + render logic (copy into your project)
- **[`src/remotion/`](src/remotion/)** — Minimal example composition with `OffthreadVideo`
- **[`scripts/build-remotion.mjs`](scripts/build-remotion.mjs)** — Build script for pre-bundling

> **Note**: Rendering requires a [Vercel Sandbox](https://vercel.com/docs/functions/sandbox) environment (deployed on Vercel). You can preview compositions locally with `npm run preview`.

---

## The Scenario

We're building a real estate video platform. The pipeline:

1. **Kling AI** generates video clips from property photos
2. **Remotion** composites them into a final video (intro, transitions, overlays, subtitles, outro)
3. The result is uploaded to storage and served to the user

We chose **Vercel Sandbox** for rendering because:
- 8 vCPU Firecracker microVMs — enough horsepower for video rendering
- 15-minute timeout — long enough for 60-90 second videos
- Snapshot support — set up once, restore in seconds
- No server to manage — pure serverless

Everything was set up. Remotion bundle pre-compiled. Chromium installed. Render script ready. Then we hit this:

```
/lib64/libc.so.6: version `GLIBC_2.35' not found (required by ./remotion)
```

What followed was 28 hours of the most frustrating debugging session of our lives.

---

## Understanding the Problem

Vercel Sandbox runs **Amazon Linux 2023** inside Firecracker microVMs. AL2023 ships with **glibc 2.34**.

Remotion's video rendering pipeline has a critical binary: the **compositor**. It's a Rust-compiled binary called `remotion` that handles frame-accurate video extraction for `OffthreadVideo`. This binary was compiled against **glibc 2.35**.

One version apart. That's it. `2.34` vs `2.35`. But in the glibc world, there's no backwards compatibility — a binary compiled against 2.35 **will not run** on a system with 2.34. Period.

Remotion ships two compositor variants:
- `@remotion/compositor-linux-x64-gnu` — needs glibc 2.35
- `@remotion/compositor-linux-x64-musl` — statically linked with musl libc (theoretically portable)

"Just use the musl version" — that's what we thought too. Here's how that went.

---

## The 28-Hour Journey

### Hour 0-4: "Just use musl, it's statically linked"

We installed `@remotion/compositor-linux-x64-musl` and pointed `binariesDirectory` to it.

**Result**: `SIGSEGV` — segmentation fault. The musl compositor's `remotion` binary crashed immediately.

We tried different configurations:
- Direct install via npm with `--force` (npm detects glibc platform and rejects musl packages)
- Manual download from npm registry
- Different `binariesDirectory` paths

Same crash every time. The musl binary had its own compatibility issues with the sandbox environment.

### Hour 4-8: "Maybe it's a shared library issue"

We thought maybe the musl binary was finding system (glibc) shared libraries instead of its bundled ones. So we tried:

- **LD_PRELOAD** to force-load specific libraries → Symbol conflicts between musl and glibc
- **Manual shared lib copying** → Still SIGSEGV, different address
- **Custom zlib build from source** → Even deeper ABI incompatibility

Each attempt required a new sandbox snapshot (3-5 minutes to create), a deploy, and a test. The feedback loop was brutal.

### Hour 8-14: "Build musl's dynamic linker from source"

We went deep. Downloaded musl source code, tried to compile `ld-musl-x86_64.so.1` inside the sandbox. The idea: if we could provide musl's own dynamic linker, the binary would use musl's libc instead of the system glibc.

**Result**: Build failed. Missing headers. Cross-compilation complexity. Even when we got a partial build, the resulting linker couldn't properly resolve all the shared libraries the compositor needed.

At this point we had gone through **snapshot versions 20-31**. Each one a different musl-based approach. Each one a failure.

### Hour 14-20: "Forget musl. Patch the GNU binary."

The key insight: **only the `remotion` Rust binary needs glibc 2.35**. The bundled `ffmpeg` and `ffprobe` work fine on glibc 2.34.

New plan:
1. Download glibc 2.35 as a **portable library set** (from Ubuntu 22.04's `.deb` package)
2. Use `patchelf` to make the `remotion` binary use this custom glibc instead of the system one

First attempt — we used a URL from `archive.ubuntu.com` to download the `.deb`:
```
curl -sfL "http://archive.ubuntu.com/ubuntu/pool/main/g/glibc/libc6_2.35-0ubuntu3.1_amd64.deb"
```

**Result**: Silent failure. The `-s` flag in curl suppressed the 404 error. The URL was wrong. The `.deb` file was empty. Everything downstream failed silently.

**Lesson learned**: Never use `curl -s` in CI/CD. Always use `-f` (fail on HTTP errors) and add explicit logging.

### Hour 20-24: "The URL works, but libswresample.so not found"

We found the correct permanent URL from Launchpad:
```
http://launchpadlibrarian.net/612471225/libc6_2.35-0ubuntu3.1_amd64.deb
```

The `.deb` uses `data.tar.zst` (zstd compression) — we needed to install `zstd` in the sandbox first. Once extracted, we had glibc 2.35 at `/opt/glibc235/`.

Downloaded the GNU compositor, ran `patchelf`:
```bash
patchelf --set-interpreter "/opt/glibc235/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2" ./remotion
patchelf --set-rpath '$ORIGIN:/opt/glibc235/lib/x86_64-linux-gnu' ./remotion
```

The `remotion` binary started! It found glibc 2.35! But then:

```
libswresample.so: cannot open shared object file: No such file or directory
```

Wait — `libswresample.so` is right there in the same directory as the binary. `$ORIGIN` should find it. What's going on?

### Hour 24-28: "DT_RPATH vs DT_RUNPATH — the final boss"

This is where we learned something about ELF binaries that isn't in most tutorials.

Linux has **two** ways to embed library search paths in a binary:

| Field | Scope | patchelf flag |
|-------|-------|--------------|
| `DT_RUNPATH` | Only **direct** dependencies | Default (no flag) |
| `DT_RPATH` | **All** dependencies, including transitive | `--force-rpath` |

The dependency chain:
```
remotion binary
  → loads libavformat.so (direct dependency — found via RUNPATH ✓)
    → loads libswresample.so (TRANSITIVE dependency — NOT found via RUNPATH ✗)
```

`patchelf` defaults to setting `DT_RUNPATH`. But `libswresample.so` is loaded by `libavformat.so`, not by `remotion` directly. `DT_RUNPATH` only applies to the binary's **own** `dlopen` calls, not to its dependencies' `dlopen` calls.

The fix was one flag:

```bash
patchelf --force-rpath --set-rpath '...' ./remotion
#        ^^^^^^^^^^^^^^
#        This changes DT_RUNPATH → DT_RPATH
#        DT_RPATH propagates to ALL transitive dependencies
```

**It worked.** After 28 hours, 13 snapshot versions, and 10 different approaches.

---

## The Solution

Here's exactly what you need to do, distilled into clean steps.

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Vercel Serverless Function (Node.js)                   │
│                                                         │
│  1. Creates/restores Vercel Sandbox (Firecracker VM)    │
│  2. Copies pre-built Remotion bundle into sandbox       │
│  3. Runs render script inside sandbox                   │
│  4. Uploads result to storage                           │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│  Vercel Sandbox (Amazon Linux 2023, 8 vCPU)             │
│                                                         │
│  - Chromium (headless, for Remotion rendering)          │
│  - @remotion/renderer + remotion (npm packages)         │
│  - GNU compositor (patched with custom glibc 2.35)      │
│  - Pre-built Remotion bundle (webpack output)           │
│  - render.mts script (ESM, runs with --strip-types)     │
└─────────────────────────────────────────────────────────┘
```

### Prerequisites

**Pre-bundle Remotion at build time.** `@remotion/bundler` uses webpack internally — running it inside a Next.js API route causes a webpack-in-webpack conflict.

```json
// package.json
{
  "scripts": {
    "build:remotion": "node scripts/build-remotion.mjs"
  }
}
```

```js
// scripts/build-remotion.mjs
import { bundle } from "@remotion/bundler";
import path from "path";

await bundle({
  entryPoint: path.resolve("src/remotion/index.ts"),
  outDir: path.resolve("remotion-build"),
});
```

### Step 1: Create Sandbox + Install Dependencies

```typescript
import { Sandbox } from "@vercel/sandbox";

const sandbox = await Sandbox.create({
  runtime: "node24",
  resources: { vcpus: 8 },
  timeout: 15 * 60 * 1000, // 15 minutes
});

// System dependencies (Chromium needs these)
await sandbox.runCommand({
  cmd: "dnf",
  args: ["install", "-y",
    "nss", "atk", "at-spi2-atk", "cups-libs", "libdrm",
    "libXcomposite", "libXdamage", "libXrandr", "mesa-libgbm",
    "alsa-lib", "pango", "gtk3"
  ],
  sudo: true,
});

// JS dependencies
await sandbox.runCommand({
  cmd: "npm",
  args: ["install", "--save",
    "@remotion/renderer@4.0.421",
    "remotion@4.0.421",
  ],
});
```

### Step 2: Install Custom glibc 2.35

Download Ubuntu 22.04's `libc6` package — it's just a portable set of shared libraries that coexists with the system glibc:

```typescript
const GLIBC_DIR = "/opt/glibc235";

await sandbox.runCommand({
  cmd: "bash",
  args: ["-c", [
    "set -e",
    // binutils (ar), patchelf, zstd (for .deb's data.tar.zst)
    "dnf install -y binutils patchelf zstd >/dev/null 2>&1",
    `mkdir -p "${GLIBC_DIR}"`,
    "cd /tmp",
    // Permanent Launchpad URL — won't change
    'curl -fL "http://launchpadlibrarian.net/612471225/libc6_2.35-0ubuntu3.1_amd64.deb" -o libc6.deb',
    "ar x libc6.deb",               // Extract .deb archive
    `tar xf data.tar.* -C "${GLIBC_DIR}"`,  // data.tar.zst → glibc libs
  ].join(" && ")],
  sudo: true,
});
```

After extraction:
```
/opt/glibc235/lib/x86_64-linux-gnu/
├── ld-linux-x86-64.so.2    ← Dynamic linker (glibc 2.35)
├── libc.so.6                ← C library (glibc 2.35)
├── libm.so.6
├── libpthread.so.0
└── ...
```

### Step 3: Download & Patch GNU Compositor

```typescript
const REMOTION_VERSION = "4.0.421";
const COMPOSITOR_DIR = "/vercel/sandbox/gnu-compositor";

// Download from npm registry
const tarball = `https://registry.npmjs.org/@remotion/compositor-linux-x64-gnu/-/compositor-linux-x64-gnu-${REMOTION_VERSION}.tgz`;

await sandbox.runCommand({
  cmd: "bash",
  args: ["-c", [
    "set -e",
    `mkdir -p "${COMPOSITOR_DIR}"`,
    `curl -sfL "${tarball}" | tar xzf - -C "${COMPOSITOR_DIR}" --strip-components=1`,
    `chmod +x "${COMPOSITOR_DIR}/ffmpeg" "${COMPOSITOR_DIR}/ffprobe" "${COMPOSITOR_DIR}/remotion"`,
  ].join(" && ")],
});
```

Now the critical patch:

```typescript
await sandbox.runCommand({
  cmd: "bash",
  args: ["-c", [
    "set -e",
    `COMP="${COMPOSITOR_DIR}"`,

    // 1. Change dynamic linker from system glibc 2.34 → custom glibc 2.35
    `patchelf --set-interpreter "${GLIBC_DIR}/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2" "$COMP/remotion"`,

    // 2. Set library search path
    //    --force-rpath is CRITICAL: uses DT_RPATH instead of DT_RUNPATH
    //    Without it, transitive dependencies (libswresample.so via libavformat.so) won't be found
    `patchelf --force-rpath --set-rpath '$ORIGIN:${GLIBC_DIR}/lib/x86_64-linux-gnu:/lib64:/usr/lib64' "$COMP/remotion"`,
  ].join(" && ")],
});
```

> **Only the `remotion` binary needs patching.** `ffmpeg` and `ffprobe` work fine on glibc 2.34.

### Step 4: Render

```typescript
import { selectComposition, renderMedia, ensureBrowser } from "@remotion/renderer";

await ensureBrowser(); // Downloads Chromium on first run

const composition = await selectComposition({
  serveUrl: "/path/to/remotion-build",
  id: "MyComposition",
  inputProps: { /* ... */ },
  binariesDirectory: COMPOSITOR_DIR,  // ← Must pass to BOTH functions
});

await renderMedia({
  composition,
  serveUrl: "/path/to/remotion-build",
  codec: "h264",
  outputLocation: "/tmp/output.mp4",
  inputProps: { /* ... */ },
  crf: 23,
  binariesDirectory: COMPOSITOR_DIR,  // ← Must pass to BOTH functions
});
```

`binariesDirectory` is the **only way** to specify custom compositor paths in Remotion v4.0+. The old `ffmpegExecutable`/`ffprobeExecutable` options were removed.

See [`src/sandbox-render.ts`](src/sandbox-render.ts) for a complete, self-contained TypeScript example with snapshot management and error handling.

---

## Optimizing for Production

### Snapshots (Skip Setup on Subsequent Renders)

Fresh sandbox creation takes 3-5 minutes. Snapshots reduce this to < 5 seconds:

```typescript
// After setup, take a snapshot (this STOPS the sandbox)
const snapshot = await sandbox.snapshot();
saveSnapshotId(snapshot.snapshotId); // Persist to DB or storage

// On next render, restore (< 5 seconds)
const sandbox = await Sandbox.create({
  source: { type: "snapshot", snapshotId: savedId },
  runtime: "node24",
  resources: { vcpus: 8 },
  timeout: 15 * 60 * 1000,
});
```

**Warning**: `sandbox.snapshot()` stops the sandbox. You must restore from the snapshot to get a usable one.

**Cost tip**: Every unique snapshot is stored and billed. If you version your snapshots (like we did — v20 through v33), each bump forces every user's next render to create a fresh sandbox. Avoid unnecessary bumps.

### Adaptive CRF (Keep File Sizes Under Control)

Remotion's default CRF (~18) produces huge files. A 60+ second 1080x1920 portrait video at CRF 18 can easily exceed 100MB. Use adaptive CRF based on duration:

```typescript
const crf = durationSeconds > 60 ? 28 : durationSeconds > 30 ? 26 : 23;
```

### Sub-pixel Jitter Fix

Headless Chromium can produce sub-pixel rendering artifacts in Remotion animations. Wrap all `interpolate()` translate values in `Math.round()`:

```typescript
// Before: jittery in headless Chromium
const translateY = interpolate(frame, [0, 30], [100, 0]);

// After: smooth
const translateY = Math.round(interpolate(frame, [0, 30], [100, 0]));
```

---

## Common Pitfalls

### `@remotion/bundler` crashes in Next.js API routes
Webpack-in-webpack conflict. Always pre-bundle with `npm run build:remotion` at build time.

### `OffthreadVideo` vs `<Video>`
- **`OffthreadVideo`**: Uses compositor for frame extraction — frame-accurate, requires the glibc fix described here
- **`<Video>`**: Uses Chromium's built-in decoder — deprecated, causes shaking/jitter in headless rendering

### `CommandFinished.stdout()` is async
In `@vercel/sandbox`, `.stdout()` and `.stderr()` return **Promises**, not strings:
```typescript
// WRONG — returns Promise object, not string
console.log(result.stdout);

// CORRECT
const stdout = await result.stdout();
console.log(stdout);
```

### `curl -s` hides failures
Always use `curl -f` (fail on HTTP errors). Don't use `-s` (silent) unless you also add explicit error handling. We lost hours because a 404 was silently ignored.

### `.deb` files may use zstd compression
Ubuntu 22.04+ uses `data.tar.zst` inside `.deb` packages. You need to `dnf install zstd` before extracting.

---

## Everything We Tried (The Complete List)

For anyone debugging similar issues, here's the full history so you don't repeat our mistakes:

| # | Approach | Result | Why It Failed |
|---|----------|--------|---------------|
| 1 | Musl compositor (direct install via npm) | `SIGSEGV` | Binary has compatibility issues with AL2023 |
| 2 | Musl compositor + manual shared libs | `SIGSEGV` | Missing/incompatible transitive dependencies |
| 3 | Musl compositor + custom zlib from source | `SIGSEGV` | Deeper ABI incompatibility between musl and system libs |
| 4 | Musl compositor + patchelf RPATH | `SIGSEGV` | Fundamental musl/glibc ABI mismatch |
| 5 | Build musl dynamic linker from source | Build failed | Complex cross-compilation, missing headers on AL2023 |
| 6 | `LD_LIBRARY_PATH` for GNU compositor | `GLIBC_2.35' not found` | Doesn't change the dynamic linker itself |
| 7 | `LD_PRELOAD` with glibc 2.35 libs | Crash | Can't preload a different glibc version over system glibc |
| 8 | Wrapper script with custom `ld.so` invocation | Partial success | Worked for direct deps, failed for transitive deps |
| 9 | GNU compositor + glibc 2.35 + `DT_RUNPATH` | `libswresample.so not found` | `DT_RUNPATH` doesn't propagate to transitive deps |
| 10 | **GNU compositor + glibc 2.35 + `DT_RPATH`** | **Success** | `--force-rpath` propagates to ALL transitive deps |

---

## Key Takeaways

1. **glibc is not forwards-compatible.** A binary compiled for 2.35 will never run on 2.34, no matter what.

2. **Musl and glibc are not interchangeable.** Even "statically linked" musl binaries can have issues on glibc systems, especially when they load shared libraries at runtime.

3. **`patchelf` is incredibly powerful.** You can make a binary use a completely different glibc without recompiling it. This is the standard approach used by Nix, AppImage, and Flatpak.

4. **`DT_RPATH` and `DT_RUNPATH` are NOT the same.** This is poorly documented. If your binary loads shared libraries that themselves load other shared libraries, you **must** use `DT_RPATH` (`--force-rpath`).

5. **Never use `curl -s` in production.** Always use `-f` to fail on HTTP errors. Silent failures are the worst kind.

6. **Snapshot invalidation is expensive.** Every version bump forces a fresh 3-5 minute sandbox creation. Plan your snapshots carefully.

---

## Environment Details

| Component | Version |
|-----------|---------|
| Vercel Sandbox | Firecracker microVM |
| OS | Amazon Linux 2023 |
| System glibc | 2.34 |
| Custom glibc | 2.35 (Ubuntu 22.04) |
| Remotion | 4.0.421 |
| Node.js | 24 (sandbox runtime) |
| patchelf | via `dnf install patchelf` |

## Related Resources

- [Remotion Documentation](https://remotion.dev/docs)
- [Vercel Sandbox Documentation](https://vercel.com/docs/functions/sandbox)
- [patchelf GitHub](https://github.com/NixOS/patchelf)
- [Understanding RPATH and RUNPATH](https://man7.org/linux/man-pages/man8/ld.so.8.html)

## License

MIT — see [LICENSE](LICENSE)

## Contributing

Found a better approach? Have questions? [Open an issue](../../issues) or submit a PR.
