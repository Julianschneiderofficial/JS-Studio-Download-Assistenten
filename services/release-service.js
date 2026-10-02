const { app } = require("electron");
const { createHash } = require("node:crypto");
const { mkdir, readFile, rename, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");

const CORE_OWNER = "Julianschneiderofficial";
const CORE_REPOSITORY = "JS-Studio-Download-Assistenten";
const CORE_BRANCH = "main";
const CORE_REF_URL =
  `https://api.github.com/repos/${CORE_OWNER}/${CORE_REPOSITORY}/git/ref/heads/${CORE_BRANCH}`;
const CORE_RAW_BASE_URL =
  `https://raw.githubusercontent.com/${CORE_OWNER}/${CORE_REPOSITORY}/`;
const CORE_FILES = ["index.html", "styles.css", "src/app.js", "catalog.json"];
const MAX_FILE_SIZE = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;

let activeCoreDirectory;
let getMainWindow;
let onCoreUpdated;
let updateInProgress;
const pendingEvents = new Map();

function sendToRenderer(channel, payload) {
  const window = getMainWindow?.();
  if (!window || window.isDestroyed() || window.webContents.isLoadingMainFrame()) {
    pendingEvents.set(channel, payload);
  } else {
    window.webContents.send(channel, payload);
  }
}

function flushPendingEvents() {
  const window = getMainWindow?.();
  if (!window || window.isDestroyed() || window.webContents.isLoadingMainFrame()) {
    return;
  }

  for (const [channel, payload] of pendingEvents) {
    window.webContents.send(channel, payload);
  }
  pendingEvents.clear();
}

function coreStorageDirectory() {
  return path.join(app.getPath("userData"), "core");
}

function resolveUiEntry() {
  const directory = activeCoreDirectory || app.getAppPath();
  return path.join(directory, "index.html");
}

function isValidManifest(manifest) {
  return manifest
    && typeof manifest === "object"
    && !Array.isArray(manifest)
    && typeof manifest.version === "string"
    && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)
    && (typeof manifest.changelog === "string"
      || (Array.isArray(manifest.changelog)
        && manifest.changelog.length <= 100
        && manifest.changelog.every((note) => typeof note === "string" && note.length <= 1000)))
    && manifest.files
    && typeof manifest.files === "object"
    && !Array.isArray(manifest.files)
    && Object.keys(manifest.files || {}).length === CORE_FILES.length
    && CORE_FILES.every((file) => /^[a-f0-9]{64}$/.test(manifest.files[file] || ""));
}

function compareVersions(left, right) {
  const leftMatch = left.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  const rightMatch = right.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  for (let index = 1; index <= 3; index += 1) {
    const a = Number(leftMatch[index]);
    const b = Number(rightMatch[index]);
    if (a === b) {
      continue;
    }
    return a > b ? 1 : -1;
  }

  const leftPrerelease = leftMatch[4]?.split(".") || [];
  const rightPrerelease = rightMatch[4]?.split(".") || [];
  if (leftPrerelease.length === 0 || rightPrerelease.length === 0) {
    return leftPrerelease.length === rightPrerelease.length ? 0 : leftPrerelease.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(leftPrerelease.length, rightPrerelease.length); index += 1) {
    const a = leftPrerelease[index];
    const b = rightPrerelease[index];
    if (a === undefined || b === undefined) {
      return a === b ? 0 : a === undefined ? -1 : 1;
    }
    if (a === b) {
      continue;
    }
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
      return Number(a) > Number(b) ? 1 : -1;
    }
    if (/^\d+$/.test(a)) {
      return -1;
    }
    if (/^\d+$/.test(b)) {
      return 1;
    }
    return a > b ? 1 : -1;
  }
  return 0;
}

async function readActiveVersion() {
  if (activeCoreDirectory) {
    return path.basename(activeCoreDirectory);
  }

  try {
    const state = JSON.parse(await readFile(path.join(coreStorageDirectory(), "active.json"), "utf8"));
    if (typeof state.version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(state.version)) {
      const directory = path.join(coreStorageDirectory(), state.version);
      await readFile(path.join(directory, "index.html"));
      activeCoreDirectory = directory;
      return state.version;
    }
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
      console.error("Der lokal gespeicherte UI-Core konnte nicht geladen werden:", error);
    }
  }

  activeCoreDirectory = app.getAppPath();
  return app.getVersion();
}

async function fetchBytes(url, maxBytes) {
  const response = await fetch(url, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`Remote-Quelle antwortete mit HTTP ${response.status}.`);
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Remote-Datei überschreitet die erlaubte Größe.");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error("Remote-Datei überschreitet die erlaubte Größe.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes);
}

async function readManifest() {
  const refBytes = await fetchBytes(CORE_REF_URL, 128 * 1024);
  const ref = JSON.parse(refBytes.toString("utf8"));
  if (
    ref.ref !== `refs/heads/${CORE_BRANCH}`
    || ref.object?.type !== "commit"
    || !/^[a-f0-9]{40}$/.test(ref.object.sha || "")
  ) {
    throw new Error("GitHub lieferte keinen gültigen Commit für den App-Core.");
  }

  const contentBaseUrl = `${CORE_RAW_BASE_URL}${ref.object.sha}/`;
  const bytes = await fetchBytes(new URL("updates/latest.json", contentBaseUrl).href, 128 * 1024);
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (!isValidManifest(manifest)) {
    throw new Error("Das Update-Manifest hat ein ungültiges Format.");
  }
  return { manifest, contentBaseUrl };
}

function formatChangelog(changelog) {
  const entries = Array.isArray(changelog) ? changelog : changelog.split(/\r?\n/);
  return entries.map((entry) => String(entry).trim()).filter(Boolean);
}

async function installCore(manifest, contentBaseUrl) {
  const storageDirectory = coreStorageDirectory();
  const versionDirectory = path.join(storageDirectory, manifest.version);
  const stagingDirectory = path.join(storageDirectory, `.staging-${manifest.version}-${process.pid}`);
  await mkdir(storageDirectory, { recursive: true });
  await rm(stagingDirectory, { recursive: true, force: true });
  await mkdir(stagingDirectory, { recursive: true });

  try {
    for (const file of CORE_FILES) {
      const url = new URL(file, contentBaseUrl).href;
      const bytes = await fetchBytes(url, MAX_FILE_SIZE);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== manifest.files[file]) {
        throw new Error(`Prüfsumme für ${file} stimmt nicht mit dem Manifest überein.`);
      }

      const destination = path.join(stagingDirectory, ...file.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: "wx" });
    }

    await rm(versionDirectory, { recursive: true, force: true });
    await rename(stagingDirectory, versionDirectory);

    const statePath = path.join(storageDirectory, "active.json");
    const temporaryStatePath = `${statePath}.${process.pid}.tmp`;
    await writeFile(temporaryStatePath, JSON.stringify({ version: manifest.version }), "utf8");
    await rename(temporaryStatePath, statePath);
    activeCoreDirectory = versionDirectory;
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function checkForUpdates({ apply = true } = {}) {
  if (updateInProgress) {
    return updateInProgress;
  }

  updateInProgress = (async () => {
    sendToRenderer("updater:status", { message: "Suche nach UI- und Katalog-Updates …", type: "info" });
    try {
      const { manifest, contentBaseUrl } = await readManifest();
      const currentVersion = await readActiveVersion();
      if (compareVersions(manifest.version, currentVersion) <= 0) {
        sendToRenderer("updater:status", { message: "UI, Logik und Katalog sind aktuell.", type: "success" });
        return { updated: false, version: currentVersion };
      }

      if (!apply) {
        sendToRenderer("updater:status", {
          message: `Core-Version ${manifest.version} ist verfügbar. Automatische Updates sind in den Einstellungen deaktiviert.`,
          type: "info"
        });
        return { updated: false, updateAvailable: true, version: manifest.version };
      }

      await installCore(manifest, contentBaseUrl);
      if (onCoreUpdated) {
        await onCoreUpdated(resolveUiEntry());
      }

      const releaseNotes = {
        version: manifest.version,
        notes: formatChangelog(manifest.changelog)
      };
      sendToRenderer("updater:release-notes", releaseNotes);
      sendToRenderer("updater:status", {
        message: `App-Core ${manifest.version} wurde ohne Neuinstallation aktualisiert.`,
        type: "success"
      });
      return { updated: true, ...releaseNotes };
    } catch (error) {
      console.error("Dynamisches Core-Update fehlgeschlagen; lokale Core-Version bleibt aktiv:", error);
      sendToRenderer("updater:status", {
        message: `Core-Update fehlgeschlagen; die vorhandene Version bleibt aktiv: ${error.message}`,
        type: "error"
      });
      throw error;
    }
  })();

  try {
    return await updateInProgress;
  } finally {
    updateInProgress = undefined;
  }
}

async function initializeReleaseService(getWindow, reloadCore, loadSettings) {
  getMainWindow = getWindow;
  onCoreUpdated = reloadCore;
  await readActiveVersion();
  const settings = await loadSettings();
  await checkForUpdates({ apply: settings.automaticUpdates });
}

async function loadCachedCore() {
  await readActiveVersion();
}

function getActiveCoreDirectory() {
  return activeCoreDirectory || app.getAppPath();
}

async function getActiveCoreVersion() {
  return readActiveVersion();
}

module.exports = {
  checkForUpdates,
  flushPendingEvents,
  getActiveCoreVersion,
  getActiveCoreDirectory,
  initializeReleaseService,
  loadCachedCore,
  resolveUiEntry
};
