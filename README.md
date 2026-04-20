[![pt-BR](https://img.shields.io/badge/lang-pt--BR-green)](README.pt-BR.md)

[![CompressorFiore Screenshot](/assets/prints.jpg)]

# CompressorFiore

Desktop app to compress video fast, no fuss. An ffmpeg wrapper built with Electron.

## Modes

- **Heavy Compress** — cuts + crushes to fit within 2MB. Great for previews/Slack.
- **Standard Compress** — H.264 CRF 24, AAC 128k. Optimized for web.
- **WhatsApp Ready** — stays under 90MB, max 1080p or 720p, optional audio.

Accepts files or folders (recursive scan). Queue processes one at a time.

## Install

Download the latest installer from [Releases](https://github.com/joaoRoncalio/web-video-compressor/releases/latest).

### macOS (Apple Silicon)

1. Open the `.dmg` and drag **CompressorFiore** to `/Applications`.
2. On first launch macOS will say **"CompressorFiore is damaged and can't be opened"**. It's not — the app isn't signed with an Apple Developer ID, and Gatekeeper blocks anything downloaded from the internet without a signature. To allow it, open Terminal and run:

   ```bash
   xattr -cr /Applications/CompressorFiore.app
   ```

### Windows (x64)

1. Run `CompressorFiore Setup x.x.x.exe`.
2. On first install SmartScreen may warn "Windows protected your PC" → **More info** → **Run anyway**.
3. Subsequent update installers run silently without any warning.

## Updates

The app checks for new GitHub releases on launch.

- **Windows:** downloads in the background and shows a **Restart** button to install.
- **macOS:** shows a **Download** button that opens the release in your browser (auto-install isn't possible without a Developer ID).

## Run in dev

```bash
npm install
npm start
```

## Local build

```bash
npm run build
```

Outputs a `.dmg` to `dist/` (Mac only). Official Mac + Windows releases are built via GitHub Actions — push a `v*` tag and the workflow handles the rest.

## Stack

Electron + electron-builder + electron-updater + ffmpeg-static + ffprobe-static.
