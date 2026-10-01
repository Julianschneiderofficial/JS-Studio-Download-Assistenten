const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const {
  compareVersions,
  downloadVerifiedInstaller,
  fetchLatestAssistantRelease,
  fetchProductManifest,
  getChangedProducts,
  getNewProducts,
  getProductManifestUrl,
  validateProductId,
  validateReleaseConfig
} = require('./release-service');

const INSTALLED_STATE_FILE = 'installed-products.json';
const CATALOG_STATE_FILE = 'catalog-products.json';
const CATALOG_REFRESH_INTERVAL_MS = 60_000;
const activeInstalls = new Set();

let mainWindow;
let releaseConfig;
let releaseConfigPath;
let installedProducts = {};
let knownCatalogVersions;
let isRefreshingCatalog = false;
let assistantUpdateRelease;
let downloadedAssistantInstaller;
let isCheckingAssistantUpdate = false;
let catalogRefreshTimer;
const rendererUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;

app.setName('JS Studio Download Assistent');
app.setAppUserModelId('com.jsstudio.downloader');

function getHostedRendererUrl() {
  const owner = releaseConfig.github.owner.toLowerCase();
  const repository = releaseConfig.github.repository;
  return `https://${owner}.github.io/${encodeURIComponent(repository)}/index.html`;
}

function isTrustedRendererUrl(value) {
  if (value === rendererUrl) return true;
  if (!app.isPackaged || !releaseConfig) return false;

  try {
    const parsed = new URL(value);
    const expected = new URL(getHostedRendererUrl());
    return parsed.protocol === 'https:'
      && parsed.origin === expected.origin
      && parsed.pathname === expected.pathname
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function assertTrustedRenderer(event) {
  if (event.sender !== mainWindow?.webContents || !isTrustedRendererUrl(event.senderFrame?.url || '')) {
    throw new Error('Diese Aktion ist nur über die Launcher-Oberfläche verfügbar.');
  }
}

function getBundledConfigPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'release-config.json')
    : path.join(__dirname, 'release-config.json');
}

async function loadReleaseConfig() {
  const userDataPath = app.getPath('userData');
  await fs.promises.mkdir(userDataPath, { recursive: true });
  releaseConfigPath = path.join(userDataPath, 'release-config.json');

  try {
    await fs.promises.access(releaseConfigPath, fs.constants.R_OK);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.promises.copyFile(getBundledConfigPath(), releaseConfigPath, fs.constants.COPYFILE_EXCL);
  }

  let source = await fs.promises.readFile(releaseConfigPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Die Release-Konfiguration ist kein gültiges JSON: ${error.message}`);
  }

  if (
    parsed &&
    typeof parsed === 'object' &&
    parsed.schemaVersion === undefined &&
    typeof parsed.productsManifestUrl === 'string' &&
    typeof parsed.assistantUpdateUrl === 'string'
  ) {
    if (parsed.productsManifestUrl || parsed.assistantUpdateUrl) {
      throw new Error(
        `Die vorhandene Release-Konfiguration verwendet noch einen alten Server. Sichere sie und ersetze ${releaseConfigPath} mit der GitHub-Konfiguration aus dem Programmpaket.`
      );
    }

    const legacyPath = `${releaseConfigPath}.legacy`;
    try {
      await fs.promises.access(legacyPath, fs.constants.F_OK);
      throw new Error(`Die alte Konfiguration wurde bereits unter ${legacyPath} gesichert.`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.promises.rename(releaseConfigPath, legacyPath);
    await fs.promises.copyFile(getBundledConfigPath(), releaseConfigPath, fs.constants.COPYFILE_EXCL);
    source = await fs.promises.readFile(releaseConfigPath, 'utf8');
    parsed = JSON.parse(source);
  }

  return validateReleaseConfig(parsed);
}

function getInstalledStatePath() {
  return path.join(app.getPath('userData'), INSTALLED_STATE_FILE);
}

function getCatalogStatePath() {
  return path.join(app.getPath('userData'), CATALOG_STATE_FILE);
}

async function loadInstalledProducts() {
  const statePath = getInstalledStatePath();
  let source;
  try {
    source = await fs.promises.readFile(statePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Der lokale Installationsstatus ist ungültig: ${error.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Der lokale Installationsstatus hat ein ungültiges Format.');
  }

  const installed = {};
  for (const [id, savedProduct] of Object.entries(parsed)) {
    const product = typeof savedProduct === 'string'
      ? { version: savedProduct, uninstaller: null }
      : savedProduct;
    if (
      !validateProductId(id) ||
      !product ||
      typeof product !== 'object' ||
      typeof product.version !== 'string' ||
      !/^\d+\.\d+\.\d+$/.test(product.version) ||
      (product.uninstaller !== null && (
        !product.uninstaller ||
        typeof product.uninstaller !== 'object' ||
        typeof product.uninstaller.downloadUrl !== 'string' ||
        !Number.isSafeInteger(product.uninstaller.sizeBytes) ||
        product.uninstaller.sizeBytes < 1 ||
        typeof product.uninstaller.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(product.uninstaller.sha256)
      ))
    ) {
      throw new Error(`Ungültiger lokaler Installationsstatus für ${id}.`);
    }
    installed[id] = product;
  }

  return installed;
}

async function loadKnownProductIds() {
  let source;
  try {
    source = await fs.promises.readFile(getCatalogStatePath(), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Der lokale Katalogstatus ist ungültig: ${error.message}`);
  }

  if (Array.isArray(parsed)) {
    return Object.fromEntries(parsed.map((id) => {
      if (!validateProductId(id)) throw new Error(`Ungültige Produkt-ID im lokalen Katalogstatus: ${id}`);
      return [id, null];
    }));
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Der lokale Katalogstatus hat ein ungültiges Format.');
  }
  for (const [id, version] of Object.entries(parsed)) {
    if (!validateProductId(id) || (version !== null && (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)))) {
      throw new Error(`Ungültiger Katalogstatus für ${id}.`);
    }
  }
  return parsed;
}

async function saveInstalledProducts() {
  const statePath = getInstalledStatePath();
  const temporaryPath = `${statePath}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporaryPath, JSON.stringify(installedProducts, null, 2), { encoding: 'utf8', flag: 'wx' });
  await fs.promises.rename(temporaryPath, statePath);
}

async function saveCatalogVersions(versions) {
  const statePath = getCatalogStatePath();
  const temporaryPath = `${statePath}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporaryPath, JSON.stringify(versions, null, 2), { encoding: 'utf8', flag: 'wx' });
  await fs.promises.rename(temporaryPath, statePath);
}

async function refreshProductReleases({ notifyChecking = true } = {}) {
  if (isRefreshingCatalog) return;
  isRefreshingCatalog = true;
  if (notifyChecking) sendToWindow('products:status', { status: 'checking' });
  try {
    const manifest = await fetchProductManifest(releaseConfig.github);
    const products = {};

    for (const [id, release] of Object.entries(manifest.products)) {
      const installedVersion = installedProducts[id]?.version || null;
      products[id] = {
        name: release.name,
        description: release.description,
        version: release.version,
        sizeBytes: release.sizeBytes,
        releaseNotes: release.releaseNotes,
        uninstaller: installedProducts[id]?.uninstaller || null,
        installedVersion,
        installed: Boolean(installedVersion),
        updateAvailable: Boolean(installedVersion && compareVersions(release.version, installedVersion) > 0)
      };
    }

    const previousVersions = knownCatalogVersions;
    const newProducts = previousVersions === undefined || previousVersions === null
      ? []
      : getNewProducts(Object.keys(previousVersions), products);
    const changedProducts = previousVersions
      ? getChangedProducts(previousVersions, products)
      : [];
    const productVersions = Object.fromEntries(
      Object.entries(products).map(([id, product]) => [id, product.version])
    );
    await saveCatalogVersions(productVersions);
    knownCatalogVersions = productVersions;
    for (const [id, installedProduct] of Object.entries(installedProducts)) {
      if (!products[id]) {
        products[id] = {
          name: installedProduct.name || id,
          description: installedProduct.description || 'Installiertes Programm',
          version: installedProduct.version,
          sizeBytes: null,
          releaseNotes: '',
          uninstaller: installedProduct.uninstaller,
          installedVersion: installedProduct.version,
          installed: true,
          updateAvailable: false,
          removedFromCatalog: true
        };
      }
    }
    sendToWindow('products:status', { status: 'ready', products, installedProducts, newProducts, changedProducts });
  } catch (error) {
    console.error('Der Programmkatalog konnte nicht geladen werden:', error);
    sendToWindow('products:status', { status: 'error', message: error.message, installedProducts });
  } finally {
    isRefreshingCatalog = false;
  }
}

function startCatalogRefresh() {
  clearInterval(catalogRefreshTimer);
  catalogRefreshTimer = setInterval(() => {
    void refreshProductReleases({ notifyChecking: false });
  }, CATALOG_REFRESH_INTERVAL_MS);
  catalogRefreshTimer.unref();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 700,
    minHeight: 540,
    title: 'JS Studio Download Assistent',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    backgroundColor: '#f3f4f6',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (app.isPackaged) {
    const hostedUrl = `${getHostedRendererUrl()}?build=${Date.now()}`;
    mainWindow.loadURL(hostedUrl, {
      extraHeaders: 'Cache-Control: no-cache\r\nPragma: no-cache\r\n'
    }).catch(async (error) => {
      console.error('Online-Oberfläche konnte nicht geladen werden; lokale Oberfläche wird verwendet:', error);
      if (mainWindow && !mainWindow.isDestroyed()) {
        await mainWindow.loadFile(path.join(__dirname, 'index.html'));
      }
    });
  } else {
    mainWindow.loadFile(path.join(__dirname, 'index.html'));
  }
  mainWindow.on('closed', () => {
    clearInterval(catalogRefreshTimer);
    catalogRefreshTimer = undefined;
    mainWindow = null;
  });
  mainWindow.on('focus', () => {
    void refreshProductReleases({ notifyChecking: false });
  });
}

function runInstaller(installerPath) {
  return new Promise((resolve, reject) => {
    const installer = spawn(installerPath, [], { stdio: 'ignore', windowsHide: false });
    installer.once('error', reject);
    installer.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Das Installationsprogramm wurde nicht erfolgreich beendet (Code ${code ?? signal ?? 'unbekannt'}).`));
      }
    });
  });
}

async function checkAssistantUpdate() {
  if (isCheckingAssistantUpdate) return;
  isCheckingAssistantUpdate = true;
  sendToWindow('assistant:update-status', { status: 'checking' });
  try {
    assistantUpdateRelease = await fetchLatestAssistantRelease(releaseConfig.github, app.getVersion());
    if (!assistantUpdateRelease) {
      sendToWindow('assistant:update-status', { status: 'current', version: app.getVersion() });
      return;
    }
    sendToWindow('assistant:update-status', {
      status: 'available',
      ...assistantUpdateRelease
    });
  } catch (error) {
    console.error('Updateinformationen für den Assistenten konnten nicht geladen werden:', error);
    sendToWindow('assistant:update-status', { status: 'error', message: error.message });
  } finally {
    isCheckingAssistantUpdate = false;
  }
}

ipcMain.handle('launcher:get-initial-state', (event) => {
  assertTrustedRenderer(event);
  return {
    appVersion: app.getVersion(),
    releaseConfigPath,
    productsConfigured: true,
    productsManifestUrl: getProductManifestUrl(releaseConfig.github),
    installedProducts
  };
});

ipcMain.handle('launcher:open-release-config', async (event) => {
  assertTrustedRenderer(event);
  const error = await shell.openPath(releaseConfigPath);
  if (error) throw new Error(`Die Release-Konfiguration konnte nicht geöffnet werden: ${error}`);
});

ipcMain.handle('products:refresh-catalog', (event) => {
  assertTrustedRenderer(event);
  return refreshProductReleases();
});

ipcMain.handle('products:install', async (event, productId) => {
  assertTrustedRenderer(event);
  if (!validateProductId(productId)) throw new Error('Ungültige Produkt-ID.');
  if (activeInstalls.has(productId)) throw new Error('Für dieses Produkt läuft bereits eine Installation.');

  activeInstalls.add(productId);
  try {
    const manifest = await fetchProductManifest(releaseConfig.github);
    const release = manifest.products[productId];
    if (!release) throw new Error('Für dieses Produkt ist noch keine Installationsdatei im öffentlichen GitHub-Release veröffentlicht.');
    const installedVersion = installedProducts[productId]?.version;
    if (installedVersion && compareVersions(release.version, installedVersion) <= 0) {
      throw new Error('Für dieses Programm ist keine neuere Katalogversion verfügbar.');
    }

    const downloadsPath = path.join(app.getPath('userData'), 'downloads');
    const installerPath = await downloadVerifiedInstaller({
      ...release,
      repository: releaseConfig.github
    }, productId, downloadsPath, (progress) => {
      sendToWindow('products:progress', { ...progress, status: 'downloading' });
    });

    sendToWindow('products:progress', { productId, status: 'installing', percent: 100 });
    await runInstaller(installerPath);

    installedProducts[productId] = {
      name: release.name,
      description: release.description,
      version: release.version,
      uninstaller: release.uninstaller
    };
    await saveInstalledProducts();
    await fs.promises.rm(installerPath, { force: true });
    sendToWindow('products:progress', { productId, status: 'installed', version: release.version, percent: 100 });
    await refreshProductReleases({ notifyChecking: false });
    return { version: release.version };
  } catch (error) {
    console.error(`Installation von ${productId} fehlgeschlagen:`, error);
    sendToWindow('products:progress', { productId, status: 'error', message: error.message });
    throw error;
  } finally {
    activeInstalls.delete(productId);
  }
});

ipcMain.handle('products:uninstall', async (event, productId) => {
  assertTrustedRenderer(event);
  if (!validateProductId(productId)) throw new Error('Ungültige Produkt-ID.');
  if (activeInstalls.has(productId)) throw new Error('Für dieses Produkt läuft bereits eine Installation.');
  const installedProduct = installedProducts[productId];
  if (!installedProduct) throw new Error('Dieses Programm ist nicht als installiert registriert.');
  if (!installedProduct.uninstaller) {
    throw new Error('Für diese bestehende Installation ist kein mitgelieferter Deinstaller hinterlegt. Verwende die Windows-Einstellungen, um sie zu entfernen.');
  }

  activeInstalls.add(productId);
  try {
    const uninstallerPath = await downloadVerifiedInstaller({
      ...installedProduct.uninstaller,
      repository: releaseConfig.github
    }, productId, path.join(app.getPath('userData'), 'downloads'), (progress) => {
      sendToWindow('products:progress', { ...progress, status: 'downloading-uninstaller' });
    }, 'uninstall');
    sendToWindow('products:progress', { productId, status: 'uninstalling' });
    await runInstaller(uninstallerPath);
    await fs.promises.rm(uninstallerPath, { force: true });
    delete installedProducts[productId];
    await saveInstalledProducts();
    sendToWindow('products:progress', { productId, status: 'uninstalled' });
    await refreshProductReleases({ notifyChecking: false });
  } catch (error) {
    console.error(`Deinstallation von ${productId} fehlgeschlagen:`, error);
    sendToWindow('products:progress', { productId, status: 'error', message: error.message });
    throw error;
  } finally {
    activeInstalls.delete(productId);
  }
});

ipcMain.handle('assistant:check-update', (event) => {
  assertTrustedRenderer(event);
  return checkAssistantUpdate();
});

ipcMain.handle('assistant:download-update', async (event) => {
  assertTrustedRenderer(event);
  if (!assistantUpdateRelease) await checkAssistantUpdate();
  if (!assistantUpdateRelease) throw new Error('Es ist keine neuere Version des Assistenten verfügbar.');

  const installerPath = await downloadVerifiedInstaller({
    ...assistantUpdateRelease,
    repository: releaseConfig.github
  }, 'assistant', path.join(app.getPath('userData'), 'downloads'), (progress) => {
    sendToWindow('assistant:update-status', {
      status: 'downloading',
      percent: progress.percent,
      receivedBytes: progress.receivedBytes,
      totalBytes: progress.totalBytes
    });
  });
  downloadedAssistantInstaller = installerPath;
  sendToWindow('assistant:update-status', {
    status: 'downloaded',
    version: assistantUpdateRelease.version,
    sizeBytes: assistantUpdateRelease.sizeBytes,
    releaseNotes: assistantUpdateRelease.releaseNotes
  });
});

ipcMain.handle('assistant:install-update', (event) => {
  assertTrustedRenderer(event);
  if (!downloadedAssistantInstaller) throw new Error('Lade zuerst das ausgewählte Assistenten-Update herunter.');
  const installer = spawn(downloadedAssistantInstaller, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  });
  installer.once('error', (error) => {
    console.error('Der Assistenten-Installer konnte nicht gestartet werden:', error);
    sendToWindow('assistant:update-status', { status: 'error', message: error.message });
  });
  installer.once('spawn', () => {
    installer.unref();
    app.quit();
  });
});

ipcMain.handle('assistant:uninstall', async (event) => {
  assertTrustedRenderer(event);
  if (process.platform !== 'win32' || !app.isPackaged) {
    throw new Error('Die Deinstallation ist nur für die installierte Windows-Version verfügbar.');
  }

  const uninstallerPath = path.join(path.dirname(app.getPath('exe')), 'Uninstall JS Studio Download Assistent.exe');
  await fs.promises.access(uninstallerPath, fs.constants.R_OK);

  return new Promise((resolve, reject) => {
    const uninstaller = spawn(uninstallerPath, [], { detached: true, stdio: 'ignore', windowsHide: true });
    uninstaller.once('error', reject);
    uninstaller.once('spawn', () => {
      uninstaller.unref();
      app.quit();
      resolve();
    });
  });
});

app.whenReady().then(async () => {
  releaseConfig = await loadReleaseConfig();
  installedProducts = await loadInstalledProducts();
  knownProductIds = await loadKnownProductIds();
  createWindow();
  mainWindow.webContents.once('did-finish-load', () => {
    void refreshProductReleases();
    void checkAssistantUpdate();
    startCatalogRefresh();
  });
}).catch((error) => {
  console.error('Der JS Studio Download Assistent konnte nicht gestartet werden:', error);
  dialog.showErrorBox('Start fehlgeschlagen', error.message);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && releaseConfig) {
    createWindow();
    mainWindow.webContents.once('did-finish-load', () => {
      void refreshProductReleases({ notifyChecking: false });
      void checkAssistantUpdate();
      startCatalogRefresh();
    });
  }
});
