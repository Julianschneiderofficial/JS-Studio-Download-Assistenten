const { app } = require("electron");
const { createHash } = require("node:crypto");
const { mkdir, readFile, rename, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");

const CORE_OWNER = "Julianschneiderofficial";
const CORE_REPOSITORY = "JS-Studio-Download-Assistenten";
const CORE_BRANCH = "main";
const CORE_RAW_BASE_URL =
  `https://raw.githubusercontent.com/${CORE_OWNER}/${CORE_REPOSITORY}/`;
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

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const SAFE_PATH = /^(?:index\.html|styles\.css|catalog\.json|(?:src|assets|styles)\/[A-Za-z0-9._\-\/]+)$/;
const POLL_INTERVAL_MS = 3 * 60 * 1000;
const API_BASE_URL = `https://api.github.com/repos/${CORE_OWNER}/${CORE_REPOSITORY}/`;

async function readActiveVersion() {
  if (activeCoreDirectory) {
    return path.basename(activeCoreDirectory);
  }

  try {
    const state = JSON.parse(await readFile(path.join(coreStorageDirectory(), "active.json"), "utf8"));
    if (typeof state.version === "string" && SHA_PATTERN.test(state.version)) {
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

async function fetchJson(url) {
  return JSON.parse((await fetchBytes(url, 4 * 1024 * 1024)).toString("utf8"));
}

function gitBlobSha(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

async function readLatestCommit() {
  const ref = await fetchJson(`${API_BASE_URL}git/ref/heads/${CORE_BRANCH}`);
  if (ref.ref !== `refs/heads/${CORE_BRANCH}` || ref.object?.type !== "commit" || !SHA_PATTERN.test(ref.object.sha || "")) {
    throw new Error("GitHub lieferte keinen gültigen Commit für den App-Core.");
  }
  return ref.object.sha;
}

async function readChangelog(newSha, oldSha) {
  try {
    const commits = await fetchJson(`${API_BASE_URL}commits?sha=${newSha}&per_page=15`);
    const notes = [];
    for (const entry of commits) {
      if (entry.sha === oldSha) {
        break;
      }
      const subject = String(entry.commit?.message || "").split(/\r?\n/)[0].trim();
      if (subject) {
        notes.push(subject);
      }
    }
    return notes.length > 0 ? notes : ["Neuer Stand aus dem Repository geladen."];
  } catch {
    return ["Neuer Stand aus dem Repository geladen."];
  }
}

async function readCoreFileList(sha) {
  const tree = await fetchJson(`${API_BASE_URL}git/trees/${sha}?recursive=1`);
  const files = (tree.tree || []).filter((entry) =>
    entry.type === "blob"
    && SAFE_PATH.test(entry.path)
    && !entry.path.split("/").includes("..")
    && SHA_PATTERN.test(entry.sha || "")
    && entry.size <= MAX_FILE_SIZE);
  for (const required of ["index.html", "styles.css", "src/app.js", "catalog.json"]) {
    if (!files.some((entry) => entry.path === required)) {
      throw new Error(`Im Repository fehlt ${required}.`);
    }
  }
  return files;
}

async function installCore(sha, files) {
  const storageDirectory = coreStorageDirectory();
  const versionDirectory = path.join(storageDirectory, sha);
  const stagingDirectory = path.join(storageDirectory, `.staging-${sha}-${process.pid}`);
  await mkdir(storageDirectory, { recursive: true });
  await rm(stagingDirectory, { recursive: true, force: true });
  await mkdir(stagingDirectory, { recursive: true });

  try {
    for (const file of files) {
      const bytes = await fetchBytes(`${CORE_RAW_BASE_URL}${sha}/${file.path}`, MAX_FILE_SIZE);
      if (gitBlobSha(bytes) !== file.sha) {
        throw new Error(`Prüfsumme für ${file.path} stimmt nicht mit GitHub überein.`);
      }
      const destination = path.join(stagingDirectory, ...file.path.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: "wx" });
    }

    await rm(versionDirectory, { recursive: true, force: true });
    await rename(stagingDirectory, versionDirectory);

    const statePath = path.join(storageDirectory, "active.json");
    const temporaryStatePath = `${statePath}.${process.pid}.tmp`;
    await writeFile(temporaryStatePath, JSON.stringify({ version: sha }), "utf8");
    await rename(temporaryStatePath, statePath);
    activeCoreDirectory = versionDirectory;
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function checkForUpdates({ apply = true, silent = false } = {}) {
  if (updateInProgress) {
    return updateInProgress;
  }

  updateInProgress = (async () => {
    if (!silent) {
      sendToRenderer("updater:status", { message: "Suche nach Updates …", type: "info" });
    }
    try {
      const latestSha = await readLatestCommit();
      const currentVersion = await readActiveVersion();
      if (latestSha === currentVersion) {
        if (!silent) {
          sendToRenderer("updater:status", { message: "Die App ist auf dem neuesten Stand.", type: "success" });
        }
        return { updated: false, version: currentVersion };
      }

      if (!apply) {
        sendToRenderer("updater:status", {
          message: "Ein neues Update ist verfügbar.",
          type: "info",
          updateAvailable: true
        });
        return { updated: false, updateAvailable: true, version: latestSha };
      }

      const files = await readCoreFileList(latestSha);
      await installCore(latestSha, files);
      const notes = await readChangelog(latestSha, SHA_PATTERN.test(currentVersion) ? currentVersion : undefined);
      if (onCoreUpdated) {
        await onCoreUpdated(resolveUiEntry());
      }

      const releaseNotes = { version: latestSha.slice(0, 7), notes };
      sendToRenderer("updater:release-notes", releaseNotes);
      sendToRenderer("updater:status", {
        message: `Update ${releaseNotes.version} wurde installiert.`,
        type: "success"
      });
      return { updated: true, ...releaseNotes };
    } catch (error) {
      console.error("Core-Update fehlgeschlagen; lokale Version bleibt aktiv:", error);
      if (!silent) {
        sendToRenderer("updater:status", {
          message: `Update fehlgeschlagen; die vorhandene Version bleibt aktiv: ${error.message}`,
          type: "error"
        });
      }
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
  setInterval(() => {
    checkForUpdates({ apply: false, silent: true }).catch(() => {});
  }, POLL_INTERVAL_MS).unref();
  await checkForUpdates({ apply: settings.automaticUpdates });
}

async function loadCachedCore() {
  await readActiveVersion();
}

function getActiveCoreDirectory() {
  return activeCoreDirectory || app.getAppPath();
}

async function getActiveCoreVersion() {
  const version = await readActiveVersion();
  return SHA_PATTERN.test(version) ? version.slice(0, 7) : version;
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