const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktop", {
  chooseDirectory: () => ipcRenderer.invoke("choose-directory"),
  onClose: (fn) => ipcRenderer.on("prepare-close", fn),
  closeReady: () => ipcRenderer.send("close-ready"),
});
