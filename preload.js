const { contextBridge, ipcRenderer, webUtils } = require("electron");

const versionArg = process.argv.find((a) => a.startsWith("--app-version="));
const appVersion = versionArg ? versionArg.split("=")[1] : "";

contextBridge.exposeInMainWorld("api", {
  appVersion,
  compressStandard: (filePath, generateThumb, jobId) =>
    ipcRenderer.invoke("compress-standard", filePath, generateThumb, jobId),
  compressHeavy: (filePath, maxSeconds, includeAudio, generateThumb, jobId) =>
    ipcRenderer.invoke("compress-heavy", filePath, maxSeconds, includeAudio, generateThumb, jobId),
  onJobProgress: (callback) =>
    ipcRenderer.on("job-progress", (_event, data) => callback(data)),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  scanPath: (filePath) => ipcRenderer.invoke("scan-path", filePath),
  cancelJob: () => ipcRenderer.invoke("cancel-job"),
});
