// Lets the website know it is running inside the desktop app (Windows or Mac), and gives its
// Settings page the update controls (Settings > Check for Updates). Nothing else of the app is reachable.
const { contextBridge, ipcRenderer } = require("electron");

const version = (process.argv.find((a) => a.startsWith("--f24-version=")) || "").split("=")[1] || "";
contextBridge.exposeInMainWorld("desktop24f", {
  platform: process.platform === "darwin" ? "mac" : "windows",
  version,
  updates: {
    get: () => ipcRenderer.invoke("updates:get"),
    check: () => ipcRenderer.invoke("updates:check"),
    install: () => ipcRenderer.invoke("updates:install"),
    setAuto: (on) => ipcRenderer.invoke("updates:auto", !!on),
    subscribe: (listener) => {
      const handler = (_event, state) => listener(state);
      ipcRenderer.on("updates:state", handler);
      return () => ipcRenderer.removeListener("updates:state", handler);
    },
  },
});
window.addEventListener("DOMContentLoaded", () => document.documentElement.classList.add("desktop-app"));
