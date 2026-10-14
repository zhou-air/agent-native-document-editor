const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("node:path");
app.whenReady().then(async () => {
  try {
    const { connect } = await import("./connection.js");
    const c = await connect();
    const win = new BrowserWindow({
      width: 1440,
      height: 960,
      minWidth: 1000,
      minHeight: 700,
      title: "Agent Document · 本地文档工作台",
      backgroundColor: "#f4f5f7",
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    ipcMain.handle("choose-directory", async () => {
      const result = await dialog.showOpenDialog(win, {
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled ? null : result.filePaths[0];
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e, url) => {
      if (new URL(url).origin !== c.url) e.preventDefault();
    });
    win.on("close", (e) => {
      if (!win.allowClose) {
        e.preventDefault();
        win.webContents.send("prepare-close");
      }
    });
    ipcMain.on("close-ready", () => {
      win.allowClose = true;
      win.close();
    });
    await win.loadURL(c.url + "/?token=" + c.token);
    if (process.env.AGENTDOC_SCREENSHOT) {
      setTimeout(async () => {
        require("node:fs").writeFileSync(
          process.env.AGENTDOC_SCREENSHOT,
          (await win.webContents.capturePage()).toPNG(),
        );
        if (process.env.AGENTDOC_CAPTURE_EXIT) {
          win.allowClose = true;
          app.quit();
        }
      }, 5000);
    }
  } catch (e) {
    dialog.showErrorBox("启动失败", e.message);
    app.quit();
  }
});
app.on("window-all-closed", () => app.quit());
