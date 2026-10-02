const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  if (typeof callback !== "function") {
    throw new TypeError("Ein Ereignis-Callback muss eine Funktion sein.");
  }

  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);

  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("downloadAssistant", {
  login: (credentials) => ipcRenderer.invoke("auth:login", credentials),
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  chooseDownloadDirectory: () => ipcRenderer.invoke("settings:choose-directory"),
  listPrograms: () => ipcRenderer.invoke("programs:list"),
  installProgram: (programId) => ipcRenderer.invoke("programs:install", programId),
  updateProgram: (programId) => ipcRenderer.invoke("programs:update", programId),
  uninstallProgram: (programId) => ipcRenderer.invoke("programs:uninstall", programId),
  checkForUpdates: () => ipcRenderer.invoke("updater:check"),
  getCoreVersion: () => ipcRenderer.invoke("core:version"),
  uninstallAssistant: () => ipcRenderer.invoke("assistant:uninstall"),
  onUpdateStatus: (callback) => subscribe("updater:status", callback),
  onReleaseNotes: (callback) => subscribe("updater:release-notes", callback),
  windowControls: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
    close: () => ipcRenderer.invoke("window:close")
  }
});
