const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  compareVersions,
  downloadVerifiedInstaller,
  fetchLatestAssistantRelease,
  getChangedProducts,
  getNewProducts,
  getProductManifestUrl,
  validateProductId,
  validateProductManifest,
  validateReleaseConfig
} = require('../release-service');

const github = {
  owner: 'Julianschneiderofficial',
  repository: 'js-studio-download-assistent',
  private: false,
  branch: 'main',
  manifestPath: 'releases/products.json'
};

const validProduct = {
  name: 'JS Studio Aufnahme Programm',
  description: 'Audioaufnahme',
  version: '1.2.3',
  sizeBytes: 1024,
  downloadUrl: 'https://github.com/Julianschneiderofficial/js-studio-download-assistent/releases/download/v1.2.3/aufnahme-setup.exe',
  sha256: 'a'.repeat(64),
  releaseNotes: 'Neue Aufnahmefunktionen.',
  uninstaller: {
    downloadUrl: 'https://github.com/Julianschneiderofficial/js-studio-download-assistent/releases/download/v1.2.3/aufnahme-uninstall.exe',
    sizeBytes: 512,
    sha256: 'b'.repeat(64)
  }
};

test('keeps the live manager interface JavaScript syntactically valid', () => {
  const html = fsSync.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/i);
  assert.ok(script, 'Expected an inline manager interface script.');
  assert.doesNotThrow(() => new vm.Script(script[1], { filename: 'index.html inline script' }));
});

test('validates the public GitHub release repository and manifest path', () => {
  assert.deepEqual(validateReleaseConfig({
    schemaVersion: 1,
    github
  }), {
    schemaVersion: 1,
    github
  });

  assert.throws(() => validateReleaseConfig({
    schemaVersion: 1,
    github: { ...github, private: true }
  }), /öffentlich/);
  assert.throws(() => validateReleaseConfig({
    schemaVersion: 1,
    github: { ...github, manifestPath: '../private/products.json' }
  }), /ungültig/);
});

test('builds the raw GitHub manifest URL from validated repository settings', () => {
  assert.equal(
    getProductManifestUrl(github),
    'https://raw.githubusercontent.com/Julianschneiderofficial/js-studio-download-assistent/main/releases/products.json'
  );
});

test('validates product releases, checksums, and repository-owned download URLs', () => {
  const manifest = validateProductManifest({
    schemaVersion: 1,
    products: { aufnahme: validProduct }
  }, github);

  assert.equal(manifest.products.aufnahme.version, '1.2.3');
  assert.equal(manifest.products.aufnahme.sizeBytes, 1024);
  assert.equal(manifest.products.aufnahme.name, 'JS Studio Aufnahme Programm');
  assert.equal(manifest.products.aufnahme.releaseNotes, 'Neue Aufnahmefunktionen.');
  assert.equal(manifest.products.aufnahme.uninstaller.sizeBytes, 512);

  assert.throws(() => validateProductManifest({
    schemaVersion: 1,
    products: { aufnahme: { ...validProduct, sha256: 'not-a-hash' } }
  }, github), /SHA-256/);
  assert.throws(() => validateProductManifest({
    schemaVersion: 1,
    products: {
      aufnahme: {
        ...validProduct,
        downloadUrl: 'https://github.com/other/repo/releases/download/v1.2.3/setup.exe'
      }
    }
  }, github), /konfigurierten GitHub-Repository/);
  assert.equal(validateProductId('new-audio-editor'), true);
  assert.equal(validateProductId('../outside'), false);
  assert.throws(() => validateProductManifest({
    schemaVersion: 1,
    products: { '../outside': validProduct }
  }, github), /Ungültige Produkt-ID/);
  assert.throws(() => validateProductManifest({
    schemaVersion: 1,
    products: { aufnahme: { ...validProduct, uninstaller: undefined } }
  }, github), /Deinstaller/);
});

test('allows an empty product manifest before installers are published', () => {
  assert.deepEqual(validateProductManifest({ schemaVersion: 1, products: {} }, github), {
    schemaVersion: 1,
    products: {}
  });
});

test('detects newly added products without treating version changes as updates', () => {
  const products = {
    aufnahme: { name: 'Aufnahme', version: '2.0.0' },
    'new-editor': { name: 'Editor', version: '1.0.0' }
  };
  assert.deepEqual(getNewProducts(['aufnahme'], products), [
    { id: 'new-editor', name: 'Editor', version: '1.0.0' }
  ]);
  assert.deepEqual(getNewProducts(Object.keys(products), products), []);
});

test('detects product version changes and compares semantic versions', () => {
  assert.deepEqual(getChangedProducts({ aufnahme: '1.1.0' }, {
    aufnahme: { name: 'Aufnahme', version: '1.2.0', sizeBytes: 2048, releaseNotes: 'Neu.' }
  }), [{
    id: 'aufnahme',
    name: 'Aufnahme',
    previousVersion: '1.1.0',
    version: '1.2.0',
    sizeBytes: 2048,
    releaseNotes: 'Neu.'
  }]);
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('loads a newer GitHub launcher release and validates its installer metadata', async (t) => {
  const installerName = 'JS-Studio-Download-Assistent-Setup-1.0.2.exe';
  const installerUrl = `https://github.com/${github.owner}/${github.repository}/releases/download/v1.0.2/${installerName}`;
  const metadataUrl = `https://github.com/${github.owner}/${github.repository}/releases/download/v1.0.2/latest.yml`;
  const installerBytes = 4096;
  const sha512 = crypto.createHash('sha512').update('installer').digest('base64');
  const metadata = [
    'version: 1.0.2',
    'files:',
    `  - url: ${installerName}`,
    `    sha512: ${sha512}`,
    `    size: ${installerBytes}`,
    `path: ${installerName}`,
    `sha512: ${sha512}`
  ].join('\n');
  const releaseBody = JSON.stringify({
    tag_name: 'v1.0.2',
    body: 'Verbesserte Installation.',
    published_at: '2026-10-01T10:00:00Z',
    draft: false,
    prerelease: false,
    assets: [
      { name: installerName, size: installerBytes, browser_download_url: installerUrl },
      { name: 'latest.yml', size: Buffer.byteLength(metadata), browser_download_url: metadataUrl }
    ]
  });

  t.mock.method(https, 'get', (url, options, callback) => {
    const isApiRequest = url.includes('/releases/latest');
    if (isApiRequest) assert.equal(options.headers.Accept, 'application/vnd.github+json');
    const responseBody = isApiRequest ? releaseBody : metadata;
    const response = new PassThrough();
    response.statusCode = 200;
    response.headers = { 'content-length': String(Buffer.byteLength(responseBody)) };
    queueMicrotask(() => {
      callback(response);
      response.end(responseBody);
    });
    return Object.assign(new EventEmitter(), {
      destroy(error) {
        this.emit('error', error);
      }
    });
  });

  assert.deepEqual(await fetchLatestAssistantRelease(github, '1.0.1'), {
    version: '1.0.2',
    releaseNotes: 'Verbesserte Installation.',
    publishedAt: '2026-10-01T10:00:00Z',
    sizeBytes: installerBytes,
    downloadUrl: installerUrl,
    sha512
  });
  assert.equal(await fetchLatestAssistantRelease(github, '1.0.2'), null);
});

test('downloads GitHub release assets over HTTPS and verifies their SHA-256', async (t) => {
  const payload = Buffer.from('github-release-fixture');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'js-studio-release-'));
  const requestedHosts = [];
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  t.mock.method(https, 'get', (url, _options, callback) => {
    const request = new EventEmitter();
    request.destroy = (error) => request.emit('error', error);
    const parsedUrl = new URL(url);
    requestedHosts.push(parsedUrl.hostname);

    queueMicrotask(() => {
      const response = new PassThrough();
      if (parsedUrl.hostname === 'github.com') {
        response.statusCode = 302;
        response.headers = {
          location: 'https://release-assets.githubusercontent.com/aufnahme-setup.exe?token=test',
          'content-length': '0'
        };
      } else {
        response.statusCode = 200;
        response.headers = { 'content-length': String(payload.length) };
      }
      callback(response);
      response.end(response.statusCode === 200 ? payload : undefined);
    });

    return request;
  });

  const release = {
    ...validProduct,
    repository: github,
    sizeBytes: payload.length,
    sha256: crypto.createHash('sha256').update(payload).digest('hex')
  };
  const installerPath = await downloadVerifiedInstaller(release, 'aufnahme', directory, () => {});
  assert.deepEqual(await fs.readFile(installerPath), payload);
  assert.deepEqual(requestedHosts, ['github.com', 'release-assets.githubusercontent.com']);

  const sha512 = crypto.createHash('sha512').update(payload).digest('base64');
  const uninstallerPath = await downloadVerifiedInstaller({
    ...release,
    sha256: undefined,
    sha512
  }, 'aufnahme', directory, () => {}, 'uninstall');
  assert.deepEqual(await fs.readFile(uninstallerPath), payload);

  await assert.rejects(
    downloadVerifiedInstaller({ ...release, sha256: '0'.repeat(64) }, 'aufnahme', directory, () => {}, 'rejected'),
    /SHA-256-Prüfung/
  );
  await assert.rejects(
    downloadVerifiedInstaller({ ...release, sha256: undefined, sha512: 'A'.repeat(88) }, 'aufnahme', directory, () => {}, 'rejected-sha512'),
    /SHA-512-Prüfung/
  );
  await assert.rejects(fs.access(path.join(directory, 'aufnahme-setup.exe.part')));
});
