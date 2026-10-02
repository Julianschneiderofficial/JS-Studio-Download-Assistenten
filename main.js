const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { access, readFile, rename, writeFile } = require("node:fs/promises");
const { spawn } = require("node:child_process");
const path = require("node:path");
const {
  checkForUpdates,
  flushPendingEvents,
  getActiveCoreVersion,
  getActiveCoreDirectory,
  initializeReleaseService,
  loadCachedCore,
  resolveUiEntry
} = require("./services/release-service");
const { assertInstallable, listPrograms } = require("./services/program-service");

const DEFAULT_SETTINGS = {
  downloadDirectory: "",
  automaticUpdates: true
};

let mainWindow;

function isTrustedRenderer(event) {
  return mainWindow
    && event.sender === mainWindow.webContents
    && event.senderFrame === mainWindow.webContents.mainFrame;
}

function validateSettings(settings) {
  if (
    !settings
    || typeof settings !== "object"
    || Array.isArray(settings)
    || typeof settings.downloadDirectory !== "string"
    || settings.downloadDirectory.length > 32768
    || typeof settings.automaticUpdates !== "boolean"
  ) {
    throw new TypeError("Die Einstellungen haben ein ungültiges Format.");
  }

  return {
    downloadDirectory: settings.downloadDirectory.trim(),
    automaticUpdates: settings.automaticUpdates
  };
}

function settingsFilePath() {
  return path.join(app.getPath("userData"), "settings.json");
}

async function loadSettings() {
  try {
    const contents = await readFile(settingsFilePath(), "utf8");
    return validateSettings(JSON.parse(contents));
  } catch (error) {
    if (error.code === "ENOENT") {
      return { ...DEFAULT_SETTINGS };
    }
    throw error;
  }
}

ipcMain.handle("auth:login", (event, credentials) => {
  if (!isTrustedRenderer(event)) {
    throw new Error("Nicht autorisierte IPC-Anfrage.");
  }
  if (
    !credentials
    || typeof credentials.username !== "string"
    || typeof credentials.password !== "string"
  ) {
    throw new TypeError("Bitte geben Sie Benutzername und Passwort ein.");
  }

  const expectedUsername = process.env.JS_STUDIO_DEMO_USERNAME;
  const expectedPassword = process.env.JS_STUDIO_DEMO_PASSWORD;
  if (!expectedUsername || !expectedPassword) {
    throw new Error("Demo-Anmeldung nicht konfiguriert. Setzen Sie JS_STUDIO_DEMO_USERNAME und JS_STUDIO_DEMO_PASSWORD.");
  }

  return {
    authenticated:
      credentials.username === expectedUsername
      && credentials.password === expectedPassword,
    username: credentials.username
  };
});

ipcMain.handle("settings:load", async (event) => {
  if (!isTrustedRenderer(event)) {
    throw new Error("Nicht autorisierte IPC-Anfrage.");
  }
  return loadSettings();
});

ipcMain.handle("settings:save", async (event, settings) => {
  if (!isTrustedRenderer(event)) {
    throw new Error("Nicht autorisierte IPC-Anfrage.");
  }

  const validatedSettings = validateSettings(settings);
  const targetPath = settingsFilePath();
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(validatedSettings, null, 2), "utf8");
  await rename(temporaryPath, targetPath);
  return validatedSettings;
});

ipcMain.handle("settings:choose-directory", async (event) => {
  if (!isTrustedRenderer(event)) {
    throw new Error("Nicht autorisierte IPC-Anfrage.");
  }
  if (!mainWindow) {
    throw new Error("Das Anwendungsfenster ist nicht verfügbar.");
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("updater:check", async (event) => {
  if (!isTrustedRenderer(event)) {
    throw new Error("Nicht autorisierte IPC-Anfrage.");
  }
  return checkForUpdates();
});

ipcMain.handle("core:version", async (event) => {
  if (!isTrustedRenderer(event)) {
    throw new Error("Nicht autorisierte IPC-Anfrage.");
  }
  return getActiveCoreVersion();
});

ipcMain.handle("window:minimize", (event) => {
  if (!isTrustedRenderer(event) || !mainWindow) {
    throw new Error("Nicht autorisierte IPC-Anfrage.");
  }
  mainWindow.minimize();
});

ipcMain.handle("window:toggle-maximize", (event) => {
  if (!isTrustedRenderer(event) || !mainWindow) {
    throw new Error("Nicht autorisierte IPC-Anfrage.");
  }
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
  return mainWindow.isMaximized();
});

ipcMain.handle("window:close", (event) => {
  if (!isTrustedRenderer(event) || !mainWindow) {
    throw new Error("Nicht autorisierte IPC-Anfrage.");
  }
  mainWindow.close();
});

ipcMain.handle("programs:list", async (event) => {
  if (!isTrustedRenderer(event)) {
    throw new Error("Nicht autorisierte IPC-Anfrage.");
  }
  return listPrograms(getActiveCoreDirectory());
});

for (const action of ["install", "update", "uninstall"]) {
  ipcMain.handle(`programs:${action}`, async (event, programId) => {
    if (!isTrustedRenderer(event)) {
      throw new Error("Nicht autorisierte IPC-Anfrage.");
    }
    const catalog = await listPrograms(getActiveCoreDirectory());
    return assertInstallable(programId, catalog);
  });
}

ipcMain.handle("assistant:uninstall", async (event) => {
  if (!isTrustedRenderer(event)) {
    throw new Error("Nicht autorisierte IPC-Anfrage.");
  }
  if (!app.isPackaged || process.platform !== "win32") {
    throw new Error("Die Deinstallation ist nur in einer installierten Windows-Version verfügbar.");
  }

  const uninstallerPath = path.join(
    path.dirname(process.execPath),
    "Uninstall JS Studio Download-Assistent.exe"
  );
  await access(uninstallerPath);

  const child = spawn(uninstallerPath, [], { detached: true, stdio: "ignore" });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  app.quit();
  return true;
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 650,
    title: "JS Studio Download-Assistent",
    frame: false,
    backgroundColor: "#f4f8ff",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
  mainWindow.loadFile(resolveUiEntry())
    .then(flushPendingEvents)
    .catch((error) => {
      console.error("Die lokale App-Oberfläche konnte nicht geladen werden:", error);
    });
}

app.whenReady().then(async () => {
  await loadCachedCore();
  createWindow();
  initializeReleaseService(
    () => mainWindow,
    async (entryPoint) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        await mainWindow.loadFile(entryPoint);
        flushPendingEvents();
      }
    },
    loadSettings
  ).catch((error) => {
    console.error("Der dynamische Core konnte nicht aktualisiert werden; der lokale Stand bleibt aktiv:", error);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
