# CompressorFiore

App desktop pra comprimir vídeo rápido, sem complicação. Wrapper de ffmpeg em Electron.

## Modos

- **Heavy Compress** — corta + esmaga pra caber em 2MB. Bom pra preview/Slack.
- **Standard Compress** — H.264 CRF 24, AAC 128k. Otimizado pra web.
- **WhatsApp Ready** — fica abaixo de 90MB, máx 1080p ou 720p, áudio opcional.

Aceita arquivos ou pastas (varre recursivo). Fila processa um por vez.

## Instalar

Baixar o instalador mais recente em [Releases](https://github.com/joaoRoncalio/web-video-compressor/releases/latest).

### macOS (Apple Silicon)

1. Abre o `.dmg`, arrasta o **CompressorFiore** pra `/Applications`.
2. Ao abrir pela primeira vez o macOS vai dizer **"CompressorFiore está danificado e não pode ser aberto"**. É mentira — o app não está assinado com Developer ID da Apple, e o Gatekeeper bloqueia tudo que foi baixado da internet sem assinatura. Pra liberar, abre o Terminal e roda:

   ```bash
   xattr -cr /Applications/CompressorFiore.app
   ```

3. Abre normal daí pra frente. Só precisa fazer isso uma vez.

### Windows (x64)

1. Rodar o `CompressorFiore Setup x.x.x.exe`.
2. Na primeira instalação o SmartScreen pode avisar "Windows protegeu seu PC" → **Mais informações** → **Executar assim mesmo**.
3. Aplicativos subsequentes de update instalam sozinhos sem aviso.

## Updates

O app checa releases novos no GitHub quando abre.

- **Windows:** baixa em background e mostra botão **Restart** pra instalar.
- **macOS:** mostra botão **Download** que abre a release no navegador (não dá pra auto-instalar sem Developer ID).

## Rodar em dev

```bash
npm install
npm start
```

## Build local

```bash
npm run build
```

Sai um `.dmg` em `dist/` (só Mac). Releases oficiais Mac + Windows são buildados via GitHub Actions — push uma tag `v*` e o workflow cuida do resto.

## Stack

Electron + electron-builder + electron-updater + ffmpeg-static + ffprobe-static.
