# CompressorFiore

App desktop pra comprimir vídeo rápido, sem complicação. Wrapper de ffmpeg em Electron.

## Modos

- **Heavy Compress** — corta + esmaga pra caber em 2MB. Bom pra preview/Slack.
- **Standard Compress** — H.264 CRF 24, AAC 128k. Otimizado pra web.
- **WhatsApp Ready** — fica abaixo de 90MB, máx 1080p ou 720p, áudio opcional.

Aceita arquivos ou pastas (varre recursivo). Fila processa um por vez.

## Rodar em dev

```bash
npm install
npm start
```

## Gerar instalador (macOS)

```bash
npm run build
```

Sai um `.dmg` em `dist/`. Por enquanto só Mac (Apple Silicon). O `ffmpeg` e `ffprobe` vão embutidos no app — não precisa instalar nada na máquina destino.

## Stack

Electron + ffmpeg-static + ffprobe-static. Build via electron-builder.
