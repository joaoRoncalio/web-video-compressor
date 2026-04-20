const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile, spawn } = require("child_process");
const { autoUpdater } = require("electron-updater");

// ffmpeg-static / ffprobe-static ship platform binaries. When packaged with
// asar, the path points inside app.asar — but binaries must live unpacked to
// be executable, so swap to app.asar.unpacked.
const resolveBinary = (modPath) =>
  modPath.replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep);

const FFMPEG = resolveBinary(require("ffmpeg-static"));
const FFPROBE = resolveBinary(require("ffprobe-static").path);

let encoderCache = null;

function listFfmpegEncoders() {
  return new Promise((resolve) => {
    execFile(FFMPEG, ["-hide_banner", "-encoders"], (err, stdout) => {
      if (err) return resolve(new Set());
      const names = new Set();
      for (const line of stdout.split("\n")) {
        const m = line.match(/^\s*[VAS][.A-Z]+\s+(\S+)/);
        if (m) names.add(m[1]);
      }
      resolve(names);
    });
  });
}

async function pickEncoder() {
  if (encoderCache) return encoderCache;
  const preferred =
    process.platform === "darwin" ? ["h264_videotoolbox"] :
    process.platform === "win32"  ? ["h264_nvenc", "h264_qsv", "h264_amf"] :
    [];
  const available = await listFfmpegEncoders();
  encoderCache = preferred.find((e) => available.has(e)) ?? "libx264";
  console.log("[encoder] selected:", encoderCache);
  return encoderCache;
}

// Tiered pipeline fallback: attempt full-GPU (hw decode + hw filter + hw
// encode), fall back to decode-only hwaccel, then CPU. `allowFullGpu` is opt-in
// per handler — complex filter graphs (aspect-ratio fits, etc.) skip tier 1
// because hw scale filters don't cover all expressions uniformly.
async function withPipelineFallback(run, { allowFullGpu = false } = {}) {
  const encoder = await pickEncoder();
  if (encoder === "libx264") return run({ encoder: "libx264", tier: "cpu" });

  const tiers = [];
  if (allowFullGpu) tiers.push("full-gpu");
  tiers.push("decode-hwaccel", "cpu");

  let lastErr;
  for (const tier of tiers) {
    const activeEncoder = tier === "cpu" ? "libx264" : encoder;
    try {
      return await run({ encoder: activeEncoder, tier });
    } catch (err) {
      if (String(err.message).includes("CANCELLED")) throw err;
      console.warn(`[pipeline] ${tier} (${activeEncoder}) failed:`, String(err.message).slice(0, 300));
      lastErr = err;
      if (tier === "cpu") throw err;
    }
  }
  throw lastErr;
}

// Decoder-side flags (go BEFORE -i). Full-GPU keeps frames in VRAM so hw
// filters/encoder can consume them directly; decode-hwaccel just accelerates
// decode and lets ffmpeg copy back to CPU for sw filters.
function inputAccelArgs(encoder, tier) {
  if (tier === "cpu") return [];
  if (tier === "decode-hwaccel") {
    switch (encoder) {
      case "h264_videotoolbox": return ["-hwaccel", "videotoolbox"];
      case "h264_nvenc":        return ["-hwaccel", "cuda"];
      case "h264_qsv":          return ["-hwaccel", "qsv"];
      case "h264_amf":          return ["-hwaccel", "d3d11va"];
      default: return [];
    }
  }
  // full-gpu
  switch (encoder) {
    case "h264_videotoolbox": return ["-hwaccel", "videotoolbox", "-hwaccel_output_format", "videotoolbox"];
    case "h264_nvenc":        return ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"];
    case "h264_qsv":          return ["-hwaccel", "qsv", "-hwaccel_output_format", "qsv"];
    case "h264_amf":          return ["-hwaccel", "d3d11va"]; // AMF has no clean hw filter path
    default: return [];
  }
}

// Hardware-side equivalent of "scale=trunc(iw/2)*2:trunc(ih/2)*2" for full-GPU.
// Returns the sw filter string for non-hw tiers.
function evenDimsScaleFilter(encoder, tier) {
  if (tier !== "full-gpu") return "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  switch (encoder) {
    case "h264_videotoolbox": return "scale_vt=w=trunc(iw/2)*2:h=trunc(ih/2)*2";
    case "h264_nvenc":        return "scale_cuda=w=trunc(iw/2)*2:h=trunc(ih/2)*2";
    case "h264_qsv":          return "scale_qsv=w=trunc(iw/2)*2:h=trunc(ih/2)*2";
    default:                  return "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  }
}

// Common video codec flags (profile, pixel format) + preset per encoder.
// In full-GPU the frames are already in a hw format the encoder accepts
// natively; forcing -pix_fmt yuv420p there breaks the hw chain.
function videoCodecArgs(encoder, tier = "cpu") {
  const pixFmt = tier === "full-gpu" ? [] : ["-pix_fmt", "yuv420p"];
  const common = ["-profile:v", "high", "-level", "4.1", ...pixFmt];
  switch (encoder) {
    case "h264_videotoolbox":
      return ["-c:v", "h264_videotoolbox", "-allow_sw", "1", ...common];
    case "h264_nvenc":
      return ["-c:v", "h264_nvenc", "-preset", "p5", ...common];
    case "h264_qsv":
      return ["-c:v", "h264_qsv", "-preset", "slower", ...common];
    case "h264_amf":
      return ["-c:v", "h264_amf", "-quality", "quality", ...common];
    default:
      return ["-c:v", "libx264", "-preset", "slow", ...common];
  }
}

// Quality-based rate control (maps libx264 CRF to each encoder's native knob).
function qualityArgs(encoder, crf) {
  switch (encoder) {
    case "h264_videotoolbox":
      // VT -q:v is 0-100, higher = better. crf 24 ~ q 60.
      return ["-q:v", "60", "-b:v", "0"];
    case "h264_nvenc":
      return ["-rc", "vbr", "-cq", String(crf), "-b:v", "0"];
    case "h264_qsv":
      return ["-global_quality", String(crf)];
    case "h264_amf":
      return ["-rc", "cqp", "-qp_i", String(crf), "-qp_p", String(crf)];
    default:
      return ["-crf", String(crf)];
  }
}

// Bitrate-capped VBR for size-targeted modes (single pass, for any encoder).
function cappedBitrateArgs(encoder, kbps) {
  const maxrate = Math.round(kbps * 1.3);
  const bufsize = kbps * 2;
  const common = ["-b:v", `${kbps}k`, "-maxrate", `${maxrate}k`, "-bufsize", `${bufsize}k`];
  switch (encoder) {
    case "h264_nvenc":
      return ["-rc", "vbr", ...common];
    case "h264_amf":
      return ["-rc", "vbr_peak", ...common];
    default:
      return common;
  }
}

let mainWindow;
let currentProc = null;
let cancelRequested = false;

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 700,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--app-version=${app.getVersion()}`],
    },
  });
  mainWindow.loadFile("index.html");

  // Update behaviour differs by platform: Windows can auto-install without
  // code signing, macOS cannot — so Mac gets a "download" banner linking to
  // the release page and Windows auto-downloads + prompts to restart.
  if (app.isPackaged) {
    autoUpdater.on("error", (err) => console.error("[updater]", err));

    if (process.platform === "win32") {
      autoUpdater.on("update-downloaded", () => {
        mainWindow?.webContents.send("update-ready-install");
      });
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    } else {
      autoUpdater.autoDownload = false;
      autoUpdater.on("update-available", (info) => {
        mainWindow?.webContents.send("update-available", {
          version: info.version,
          url: "https://github.com/joaoRoncalio/compressorfiore/releases/latest",
        });
      });
      autoUpdater.checkForUpdates().catch(() => {});
    }
  }
});

ipcMain.handle("open-external", (_e, url) => shell.openExternal(url));
ipcMain.handle("install-update", () => autoUpdater.quitAndInstall());
ipcMain.handle("reveal-in-folder", (_e, filePath) => {
  if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
});
ipcMain.handle("get-encoder", () => pickEncoder());

app.on("window-all-closed", () => app.quit());

// Extract first frame as optimized JPEG thumbnail
function generateThumbnail(videoPath) {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath));
  const thumbPath = uniquePath(path.join(dir, `${base}_thumb.jpg`));
  return new Promise((resolve, reject) => {
    execFile(
      FFMPEG,
      [
        "-y", "-i", videoPath,
        "-vframes", "1", "-q:v", "2",
        thumbPath,
      ],
      (err) => (err ? reject(err) : resolve(thumbPath))
    );
  });
}

// Find a non-colliding output path: foo_web.mp4 -> foo_web-2.mp4 -> foo_web-3.mp4 ...
function uniquePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  let i = 2;
  while (fs.existsSync(path.join(dir, `${base}-${i}${ext}`))) i++;
  return path.join(dir, `${base}-${i}${ext}`);
}

// Recursively scan a directory for video files
const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".flv", ".wmv",
]);

function scanForVideos(dirPath) {
  const results = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...scanForVideos(fullPath));
    } else if (VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      const nameNoExt = path.basename(entry.name, path.extname(entry.name));
      const isOurOutput = /_short-heavy-compress(-\d+)?$|_web(-\d+)?$|_whatsapp(-\d+)?$|_thumb(-\d+)?$/.test(nameNoExt);
      if (!isOurOutput) results.push(fullPath);
    }
  }
  return results;
}

ipcMain.handle("scan-path", async (_event, filePath) => {
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      return scanForVideos(filePath);
    }
    return [filePath];
  } catch {
    return [];
  }
});

// Get video duration in seconds
function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      FFPROBE,
      [
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        filePath,
      ],
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const info = JSON.parse(stdout);
          resolve(parseFloat(info.format.duration));
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

// Run ffmpeg and report progress
function runFfmpeg(args, duration, jobId) {
  return new Promise((resolve, reject) => {
    cancelRequested = false;
    const proc = spawn(FFMPEG, args);
    currentProc = proc;
    let stderr = "";

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
      // Parse progress from ffmpeg stderr
      const timeMatch = data.toString().match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (timeMatch && duration > 0) {
        const secs =
          parseInt(timeMatch[1]) * 3600 +
          parseInt(timeMatch[2]) * 60 +
          parseFloat(timeMatch[3]);
        const progress = Math.min(100, Math.round((secs / duration) * 100));
        mainWindow?.webContents.send("job-progress", { jobId, progress });
      }
    });

    proc.on("close", (code) => {
      currentProc = null;
      if (cancelRequested) {
        cancelRequested = false;
        reject(new Error("CANCELLED"));
        return;
      }
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}\n${stderr.slice(-500)}`));
    });

    proc.on("error", (err) => {
      currentProc = null;
      reject(err);
    });
  });
}

ipcMain.handle("cancel-job", () => {
  if (currentProc) {
    cancelRequested = true;
    currentProc.kill("SIGTERM");
  }
});

// Standard web compression (webvid equivalent)
ipcMain.handle("compress-standard", async (_event, filePath, generateThumb, jobId) => {
  console.log("[standard] filePath:", filePath);
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const output = uniquePath(path.join(dir, `${base}_web.mp4`));

  const duration = await getVideoDuration(filePath);

  await withPipelineFallback(async ({ encoder, tier }) => {
    const args = [
      "-y",
      ...inputAccelArgs(encoder, tier),
      "-i", filePath,
      "-map", "0:v:0", "-map", "0:a:0?",
      ...videoCodecArgs(encoder, tier),
      ...qualityArgs(encoder, 24),
      "-vf", evenDimsScaleFilter(encoder, tier),
      "-movflags", "+faststart",
      "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
      output,
    ];
    await runFfmpeg(args, duration, jobId);
  }, { allowFullGpu: true });

  const inputSize = fs.statSync(filePath).size;
  const outputSize = fs.statSync(output).size;
  if (outputSize >= inputSize) {
    fs.unlinkSync(output);
    throw new Error("OUTPUT_LARGER");
  }

  if (generateThumb) await generateThumbnail(output);
  return output;
});

// WhatsApp-ready: <90MB output, capped resolution, optional audio
ipcMain.handle("compress-whatsapp", async (_event, filePath, maxHeight, includeAudio, generateThumb, jobId) => {
  console.log("[whatsapp] filePath:", filePath, "maxHeight:", maxHeight, "audio:", includeAudio);
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const output = uniquePath(path.join(dir, `${base}_whatsapp.mp4`));

  const duration = await getVideoDuration(filePath);

  // Decimal-MB budget; WhatsApp's 100MB cap with headroom
  const targetKbits = 88 * 8000;
  const audioBitrate = includeAudio ? 128 : 0;
  const computedVideo = Math.floor(targetKbits / duration) - audioBitrate;

  // Scale-to-fit inside cap, downscale only, even dims for yuv420p
  const maxW = maxHeight === 720 ? 1280 : 1920;
  const maxH = maxHeight === 720 ? 720 : 1080;
  const scaleFilter =
    `scale='min(${maxW},iw)':'min(${maxH},ih)':force_original_aspect_ratio=decrease,` +
    `scale=trunc(iw/2)*2:trunc(ih/2)*2`;

  const audioArgs = includeAudio
    ? ["-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2"]
    : ["-an"];

  await withPipelineFallback(async ({ encoder, tier }) => {
    const accel = inputAccelArgs(encoder, tier);
    const commonV = [...videoCodecArgs(encoder, tier), "-vf", scaleFilter];

    // GPU: always single-pass VBR capped at the computed bitrate budget.
    // libx264: short clips use CRF+maxrate, longer clips use 2-pass for precision.
    if (encoder !== "libx264") {
      const videoBitrate = Math.max(500, computedVideo);
      const args = [
        "-y", ...accel, "-i", filePath,
        "-map", "0:v:0",
        ...(includeAudio ? ["-map", "0:a:0?"] : []),
        ...commonV,
        ...cappedBitrateArgs(encoder, videoBitrate),
        "-movflags", "+faststart",
        ...audioArgs,
        output,
      ];
      await runFfmpeg(args, duration, jobId);
    } else if (computedVideo > 10000) {
      const args = [
        "-y", "-i", filePath,
        "-map", "0:v:0",
        ...(includeAudio ? ["-map", "0:a:0?"] : []),
        ...commonV,
        "-crf", "20",
        "-maxrate", "10M", "-bufsize", "20M",
        "-movflags", "+faststart",
        ...audioArgs,
        output,
      ];
      await runFfmpeg(args, duration, jobId);
    } else {
      const videoBitrate = Math.max(500, computedVideo);
      const passLogFile = path.join(dir, `${base}_whatsapp_2pass`);

      const pass1Args = [
        "-y", "-i", filePath,
        "-map", "0:v:0",
        ...commonV,
        "-b:v", `${videoBitrate}k`,
        "-pass", "1", "-passlogfile", passLogFile,
        "-an", "-f", "null",
        process.platform === "win32" ? "NUL" : "/dev/null",
      ];
      await runFfmpeg(pass1Args, duration, jobId);

      const pass2Args = [
        "-y", "-i", filePath,
        "-map", "0:v:0",
        ...(includeAudio ? ["-map", "0:a:0?"] : []),
        ...commonV,
        "-b:v", `${videoBitrate}k`,
        "-pass", "2", "-passlogfile", passLogFile,
        "-movflags", "+faststart",
        ...audioArgs,
        output,
      ];

      try {
        await runFfmpeg(pass2Args, duration, jobId);
      } finally {
        for (const suffix of ["-0.log", "-0.log.mbtree"]) {
          try { fs.unlinkSync(passLogFile + suffix); } catch {}
        }
      }
    }
  });

  if (generateThumb) await generateThumbnail(output);
  return output;
});

// Heavy compression: trim to N seconds, target 2MB max
ipcMain.handle("compress-heavy", async (_event, filePath, maxSeconds, includeAudio, generateThumb, jobId) => {
  console.log("[heavy] filePath:", filePath, "maxSeconds:", maxSeconds, "audio:", includeAudio);
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const output = uniquePath(path.join(dir, `${base}_short-heavy-compress.mp4`));

  const totalDuration = await getVideoDuration(filePath);
  const clipDuration = Math.min(maxSeconds, totalDuration);

  // Target 2MB = 2 * 1024 * 8 kbits = 16384 kbits
  const targetSizeKbits = 2 * 1024 * 8;
  const audioBitrate = includeAudio ? 128 : 0; // kbps
  const videoBitrate = Math.floor(targetSizeKbits / clipDuration - audioBitrate);

  // Ensure minimum video bitrate
  const finalVideoBitrate = Math.max(100, videoBitrate);

  const scaleFilter = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  const audioArgs = includeAudio
    ? ["-c:a", "aac", "-b:a", `${audioBitrate}k`, "-ar", "48000", "-ac", "2"]
    : ["-an"];

  await withPipelineFallback(async ({ encoder, tier }) => {
    const accel = inputAccelArgs(encoder, tier);
    const commonV = [...videoCodecArgs(encoder, tier), "-vf", scaleFilter];

    if (encoder !== "libx264") {
      // GPU: single-pass VBR capped. Slightly looser size accuracy, much faster.
      const args = [
        "-y", ...accel, "-i", filePath,
        "-t", String(clipDuration),
        "-map", "0:v:0",
        ...(includeAudio ? ["-map", "0:a:0?"] : []),
        ...commonV,
        ...cappedBitrateArgs(encoder, finalVideoBitrate),
        "-movflags", "+faststart",
        ...audioArgs,
        output,
      ];
      await runFfmpeg(args, clipDuration, jobId);
      return;
    }

    // libx264 two-pass
    const passLogFile = path.join(dir, `${base}_2pass`);

    const pass1Args = [
      "-y", "-i", filePath,
      "-t", String(clipDuration),
      "-map", "0:v:0",
      ...commonV,
      "-b:v", `${finalVideoBitrate}k`,
      "-pass", "1", "-passlogfile", passLogFile,
      "-an", "-f", "null",
      process.platform === "win32" ? "NUL" : "/dev/null",
    ];
    await runFfmpeg(pass1Args, clipDuration, jobId);

    const pass2Args = [
      "-y", "-i", filePath,
      "-t", String(clipDuration),
      "-map", "0:v:0",
      ...(includeAudio ? ["-map", "0:a:0?"] : []),
      ...commonV,
      "-b:v", `${finalVideoBitrate}k`,
      "-pass", "2", "-passlogfile", passLogFile,
      "-movflags", "+faststart",
      ...audioArgs,
      output,
    ];

    try {
      await runFfmpeg(pass2Args, clipDuration, jobId);
    } finally {
      for (const suffix of ["-0.log", "-0.log.mbtree"]) {
        try { fs.unlinkSync(passLogFile + suffix); } catch {}
      }
    }
  });

  if (generateThumb) await generateThumbnail(output);
  return output;
});
