const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const PRODUCT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_INSTALLER_BYTES = 2 * 1024 * 1024 * 1024;
const GITHUB_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com'
]);

function validateHttpsUrl(value, label, { allowEmpty = false } = {}) {
  if (allowEmpty && value === '') return '';
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error(`${label} ist keine gültige URL.`);
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} ist keine gültige URL.`);
  }

  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`${label} muss eine HTTPS-Adresse ohne Zugangsdaten sein.`);
  }

  return url.toString();
}

function validateProductId(value) {
  return typeof value === 'string' && PRODUCT_ID_PATTERN.test(value);
}

function validateReleaseConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) {
    throw new Error('Die GitHub-Release-Konfiguration hat ein unbekanntes Format.');
  }

  const github = value.github;
  if (!github || typeof github !== 'object' || Array.isArray(github)) {
    throw new Error('In der Release-Konfiguration fehlt die GitHub-Einstellung.');
  }
  if (typeof github.owner !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(github.owner)) {
    throw new Error('Der GitHub-Benutzername oder die Organisation ist ungültig.');
  }
  if (typeof github.repository !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(github.repository)) {
    throw new Error('Der GitHub-Repositoryname ist ungültig.');
  }
  if (github.private !== false) {
    throw new Error('GitHub-Releases müssen öffentlich sein, damit sie ohne eingebettetes Zugriffstoken erreichbar sind.');
  }

  const branch = github.branch || 'main';
  const manifestPath = github.manifestPath || 'releases/products.json';
  if (typeof branch !== 'string' || !/^[A-Za-z0-9._/-]{1,100}$/.test(branch) || branch.includes('..')) {
    throw new Error('Der GitHub-Branch ist ungültig.');
  }
  if (typeof manifestPath !== 'string' || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9._-]+)*\.json$/.test(manifestPath)) {
    throw new Error('Der Pfad zum Produkt-Manifest ist ungültig.');
  }

  return {
    schemaVersion: 1,
    github: {
      owner: github.owner,
      repository: github.repository,
      private: false,
      branch,
      manifestPath
    }
  };
}

function validateProductManifest(value, repository) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) {
    throw new Error('Das Produkt-Manifest hat ein unbekanntes Format.');
  }

  if (!value.products || typeof value.products !== 'object' || Array.isArray(value.products)) {
    throw new Error('Im Produkt-Manifest fehlt die Produktliste.');
  }
  const products = {};
  for (const [id, release] of Object.entries(value.products)) {
    if (!validateProductId(id)) {
      throw new Error(`Ungültige Produkt-ID im Release-Manifest: ${id}`);
    }
    if (!release || typeof release !== 'object' || Array.isArray(release)) {
      throw new Error(`Release-Daten für ${id} sind ungültig.`);
    }
    if (typeof release.name !== 'string' || !release.name.trim() || release.name.length > 80) {
      throw new Error(`Der Produktname für ${id} fehlt oder ist ungültig.`);
    }
    if (typeof release.description !== 'string' || !release.description.trim() || release.description.length > 120) {
      throw new Error(`Die Produktbeschreibung für ${id} fehlt oder ist ungültig.`);
    }
    if (typeof release.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(release.version)) {
      throw new Error(`Die Release-Version für ${id} ist ungültig.`);
    }
    if (!Number.isSafeInteger(release.sizeBytes) || release.sizeBytes < 1 || release.sizeBytes > MAX_INSTALLER_BYTES) {
      throw new Error(`Die Paketgröße für ${id} ist ungültig.`);
    }
    if (typeof release.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(release.sha256)) {
      throw new Error(`Die SHA-256-Prüfsumme für ${id} fehlt oder ist ungültig.`);
    }
    if (release.releaseNotes !== undefined && (typeof release.releaseNotes !== 'string' || release.releaseNotes.length > 2000)) {
      throw new Error(`Die Versionshinweise für ${id} sind ungültig.`);
    }

    const downloadUrl = validateHttpsUrl(release.downloadUrl, `downloadUrl für ${id}`);
    const expectedAssetPrefix = `/${repository.owner}/${repository.repository}/releases/download/`;
    const downloadPath = new URL(downloadUrl).pathname;
    if (new URL(downloadUrl).hostname !== 'github.com' || !downloadPath.startsWith(expectedAssetPrefix)) {
      throw new Error(`Die Installationsdatei für ${id} muss als Asset eines Releases aus dem konfigurierten GitHub-Repository stammen.`);
    }

    const uninstaller = release.uninstaller;
    if (!uninstaller || typeof uninstaller !== 'object' || Array.isArray(uninstaller)) {
      throw new Error(`Für ${id} fehlt der zum Produkt gehörende Deinstaller.`);
    }
    if (!Number.isSafeInteger(uninstaller.sizeBytes) || uninstaller.sizeBytes < 1 || uninstaller.sizeBytes > MAX_INSTALLER_BYTES) {
      throw new Error(`Die Dateigröße des Deinstallers für ${id} ist ungültig.`);
    }
    if (typeof uninstaller.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(uninstaller.sha256)) {
      throw new Error(`Die SHA-256-Prüfsumme des Deinstallers für ${id} ist ungültig.`);
    }

    products[id] = {
      name: release.name.trim(),
      description: release.description.trim(),
      version: release.version,
      sizeBytes: release.sizeBytes,
      downloadUrl,
      sha256: release.sha256.toLowerCase(),
      releaseNotes: (release.releaseNotes || '').trim(),
      uninstaller: {
        downloadUrl: validateHttpsUrl(uninstaller.downloadUrl, `Deinstaller-URL für ${id}`),
        sizeBytes: uninstaller.sizeBytes,
        sha256: uninstaller.sha256.toLowerCase()
      }
    };
    const uninstallerUrl = new URL(products[id].uninstaller.downloadUrl);
    if (
      uninstallerUrl.hostname !== 'github.com' ||
      !uninstallerUrl.pathname.startsWith(expectedAssetPrefix)
    ) {
      throw new Error(`Der Deinstaller für ${id} muss aus einem Release des konfigurierten GitHub-Repositories stammen.`);
    }
  }

  return { schemaVersion: 1, products };
}

function requestHttps(url, maxBytes, redirectCount = 0, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 15000, headers }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location;
        response.resume();
        if (!location || redirectCount >= 5) {
          reject(new Error('Der GitHub-Download enthält eine ungültige oder zu lange Weiterleitung.'));
          return;
        }

        let redirectUrl;
        try {
          redirectUrl = new URL(location, url);
          validateHttpsUrl(redirectUrl.toString(), 'GitHub-Download-Weiterleitung');
        } catch (error) {
          reject(error);
          return;
        }
        if (!GITHUB_DOWNLOAD_HOSTS.has(redirectUrl.hostname)) {
          reject(new Error('GitHub hat auf einen nicht zugelassenen Download-Server weitergeleitet.'));
          return;
        }
        requestHttps(redirectUrl.toString(), maxBytes, redirectCount + 1, headers).then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Der Server antwortete mit HTTP ${response.statusCode || 'unbekannt'}.`));
        return;
      }

      const contentLength = Number(response.headers['content-length']);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        response.destroy();
        reject(new Error('Die Antwort des Release-Servers ist zu groß.'));
        return;
      }

      resolve(response);
    });

    request.on('timeout', () => request.destroy(new Error('Zeitüberschreitung beim Release-Server.')));
    request.on('error', reject);
  });
}

async function fetchJson(url, maxBytes = MAX_MANIFEST_BYTES, headers = {}) {
  const source = await fetchText(url, maxBytes, headers);

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Die Antwort des Release-Servers enthält kein gültiges JSON: ${error.message}`);
  }
}

function getProductManifestUrl(github) {
  const branch = github.branch.split('/').map(encodeURIComponent).join('/');
  const manifestPath = github.manifestPath.split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${encodeURIComponent(github.owner)}/${encodeURIComponent(github.repository)}/${branch}/${manifestPath}`;
}

async function fetchProductManifest(github) {
  const manifestUrl = new URL(getProductManifestUrl(github));
  manifestUrl.searchParams.set('_', String(Date.now()));
  const manifest = await fetchJson(manifestUrl.toString());
  return validateProductManifest(manifest, github);
}

async function downloadVerifiedInstaller(release, productId, downloadDirectory, onProgress, suffix = 'setup') {
  if (!validateProductId(productId)) throw new Error('Ungültige Produkt-ID.');
  const releaseUrl = validateHttpsUrl(release.downloadUrl, `downloadUrl für ${productId}`);
  const pathPrefix = `/${release.repository.owner}/${release.repository.repository}/releases/download/`;
  if (new URL(releaseUrl).hostname !== 'github.com' || !new URL(releaseUrl).pathname.startsWith(pathPrefix)) {
    throw new Error('Die Installationsdatei muss aus einem Release des konfigurierten GitHub-Repositories stammen.');
  }

  await fs.promises.mkdir(downloadDirectory, { recursive: true });
  const finalPath = path.join(downloadDirectory, `${productId}-${suffix}.exe`);
  const partialPath = `${finalPath}.part`;
  await fs.promises.rm(partialPath, { force: true });
  await fs.promises.rm(finalPath, { force: true });
  const response = await requestHttps(releaseUrl, MAX_INSTALLER_BYTES);
  const hashAlgorithm = release.sha512 ? 'sha512' : 'sha256';
  const hash = crypto.createHash(hashAlgorithm);
  let receivedBytes = 0;

  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > release.sizeBytes || receivedBytes > MAX_INSTALLER_BYTES) {
        callback(new Error('Die heruntergeladene Datei ist größer als im Manifest angegeben.'));
        return;
      }
      hash.update(chunk);
      onProgress({
        productId,
        receivedBytes,
        totalBytes: release.sizeBytes,
        percent: Math.min(100, Math.floor((receivedBytes / release.sizeBytes) * 100))
      });
      callback(null, chunk);
    }
  });

  try {
    await pipeline(response, meter, fs.createWriteStream(partialPath, { flags: 'wx' }));

    if (receivedBytes !== release.sizeBytes) {
      throw new Error('Die heruntergeladene Dateigröße stimmt nicht mit dem Manifest überein.');
    }
    const actualHash = hashAlgorithm === 'sha512' ? hash.digest('base64') : hash.digest('hex');
    const expectedHash = hashAlgorithm === 'sha512' ? release.sha512 : release.sha256;
    if (actualHash !== expectedHash) {
      const hashLabel = hashAlgorithm === 'sha512' ? 'SHA-512' : 'SHA-256';
      throw new Error(`Die ${hashLabel}-Prüfung der Installationsdatei ist fehlgeschlagen.`);
    }

    await fs.promises.rename(partialPath, finalPath);
    return finalPath;
  } catch (error) {
    await fs.promises.rm(partialPath, { force: true }).catch((cleanupError) => {
      console.error('Temporäre Installationsdatei konnte nicht entfernt werden:', cleanupError);
    });
    throw error;
  }
}

function getNewProducts(previousProductIds, products) {
  const previousIds = new Set(previousProductIds);
  return Object.entries(products)
    .filter(([id]) => !previousIds.has(id))
    .map(([id, product]) => ({ id, ...product }));
}

function getChangedProducts(previousVersions, products) {
  return Object.entries(products)
    .filter(([id, product]) => previousVersions[id] && previousVersions[id] !== product.version)
    .map(([id, product]) => ({
      id,
      name: product.name,
      previousVersion: previousVersions[id],
      version: product.version,
      sizeBytes: product.sizeBytes,
      releaseNotes: product.releaseNotes
    }));
}

function compareVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return Math.sign(leftParts[index] - rightParts[index]);
  }
  return 0;
}

function getGitHubRepositoryUrl(github) {
  return `https://api.github.com/repos/${encodeURIComponent(github.owner)}/${encodeURIComponent(github.repository)}`;
}

function assertRepositoryAssetUrl(value, github, label) {
  const assetUrl = new URL(validateHttpsUrl(value, label));
  if (
    assetUrl.hostname !== 'github.com' ||
    !assetUrl.pathname.startsWith(`/${github.owner}/${github.repository}/releases/download/`)
  ) {
    throw new Error(`${label} muss aus einem Release des konfigurierten GitHub-Repositories stammen.`);
  }
  return assetUrl.toString();
}

async function fetchLatestAssistantRelease(github, currentVersion) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'JS-Studio-Download-Assistent'
  };
  const release = await fetchJson(`${getGitHubRepositoryUrl(github)}/releases/latest`, MAX_MANIFEST_BYTES, headers);
  const versionMatch = typeof release.tag_name === 'string' && /^v(\d+\.\d+\.\d+)$/.exec(release.tag_name);
  if (!versionMatch || compareVersions(versionMatch[1], currentVersion) <= 0) return null;
  if (release.draft || release.prerelease || !Array.isArray(release.assets)) {
    throw new Error('Das neueste GitHub-Release des Assistenten hat ein ungültiges Format.');
  }

  const expectedFilename = `JS-Studio-Download-Assistent-Setup-${versionMatch[1]}.exe`;
  const installerAsset = release.assets.find((asset) => asset.name === expectedFilename);
  const metadataAsset = release.assets.find((asset) => asset.name === 'latest.yml');
  if (!installerAsset || !metadataAsset) {
    throw new Error(`Das Release ${release.tag_name} enthält keinen vollständigen Windows-Installer mit latest.yml.`);
  }

  const installerUrl = assertRepositoryAssetUrl(installerAsset.browser_download_url, github, 'Windows-Installer');
  const metadataUrl = assertRepositoryAssetUrl(metadataAsset.browser_download_url, github, 'Update-Metadaten');
  const metadataText = await fetchText(metadataUrl, MAX_MANIFEST_BYTES);
  const metadataVersion = /^version:\s*(\d+\.\d+\.\d+)\s*$/m.exec(metadataText)?.[1];
  const assetFilename = /^  - url:\s*(.+?)\s*$/m.exec(metadataText)?.[1];
  const sha512 = /^    sha512:\s*([A-Za-z0-9+/]+={0,2})\s*$/m.exec(metadataText)?.[1];
  const sizeBytes = Number(/^    size:\s*(\d+)\s*$/m.exec(metadataText)?.[1]);
  const pathValue = /^path:\s*(.+?)\s*$/m.exec(metadataText)?.[1];
  const digest = sha512 ? Buffer.from(sha512, 'base64') : null;

  if (
    metadataVersion !== versionMatch[1] ||
    assetFilename !== expectedFilename ||
    pathValue !== expectedFilename ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 1 ||
    sizeBytes !== installerAsset.size ||
    !digest ||
    digest.length !== 64
  ) {
    throw new Error('Die Update-Metadaten für den Windows-Installer sind ungültig oder unvollständig.');
  }

  return {
    version: versionMatch[1],
    releaseNotes: typeof release.body === 'string' && release.body.trim()
      ? release.body.trim().slice(0, 4000)
      : 'Keine Versionshinweise veröffentlicht.',
    publishedAt: release.published_at || '',
    sizeBytes,
    downloadUrl: installerUrl,
    sha512
  };
}

async function fetchText(url, maxBytes = MAX_MANIFEST_BYTES, headers = {}) {
  const response = await requestHttps(url, maxBytes, 0, headers);
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      response.destroy();
      throw new Error('Die Antwort des Release-Servers ist zu groß.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

module.exports = {
  compareVersions,
  downloadVerifiedInstaller,
  fetchLatestAssistantRelease,
  fetchProductManifest,
  getChangedProducts,
  getNewProducts,
  getProductManifestUrl,
  validateProductId,
  validateProductManifest,
  validateReleaseConfig
};
