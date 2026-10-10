// The title bar's only bridge to the shell: the update pill, the tabs (when the site asks for them),
// and the platform (the bar leaves room for the macOS traffic lights on the left, the Windows caption
// buttons on the right).
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("bar24f", {
  platform: process.platform === "darwin" ? "mac" : "windows",
  installUpdate: () => ipcRenderer.send("bar:install-update"),
  showTab: (side) => ipcRenderer.send("bar:tab", side === "right" ? "right" : "left"),
  tabMenu: () => ipcRenderer.send("bar:tab-menu", "right"),
});
