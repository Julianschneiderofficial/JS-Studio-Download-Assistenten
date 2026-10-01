const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const debounceMs = 15_000;
let debounceTimer;
let publishInProgress = false;
let publishRequestedAgain = false;

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  }).trim();
}

function assertPublishTarget() {
  const branch = git(['branch', '--show-current']);
  if (branch !== 'main') {
    throw new Error(`Der Live-Publisher veröffentlicht nur den Branch main (aktueller Branch: ${branch || 'unbekannt'}).`);
  }

  const remote = git(['remote', 'get-url', 'origin']);
  const normalizedRemote = remote
    .replace(/^git@github\.com:/i, 'https://github.com/')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (
    normalizedRemote !== 'https://github.com/julianschneiderofficial/js-studio-download-assistent' ||
    /\/\/[^/]*@/.test(normalizedRemote)
  ) {
    throw new Error('Der Remote origin muss auf das konfigurierte GitHub-Repository zeigen, ohne eingebettete Zugangsdaten.');
  }
}

function hasPendingInterfaceChange() {
  try {
    git(['diff', '--quiet', '--', 'index.html']);
    git(['diff', '--cached', '--quiet', '--', 'index.html']);
    return false;
  } catch (error) {
    if (error.status === 1) return true;
    throw error;
  }
}

function publishInterface() {
  assertPublishTarget();
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], {
    cwd: projectRoot,
    stdio: 'inherit',
    windowsHide: true
  });

  if (!hasPendingInterfaceChange()) {
    console.log('Keine neue Änderung an index.html zum Veröffentlichen.');
    return;
  }

  git(['add', '--', 'index.html']);
  git(['commit', '--only', '-m', `Live-Oberfläche: ${new Date().toLocaleString('de-DE')}`, '--', 'index.html'], {
    stdio: 'inherit'
  });
  git(['push', 'origin', 'main'], { stdio: 'inherit' });
  console.log('Änderung veröffentlicht. GitHub Actions stellt sie als Live-Oberfläche bereit.');
}

function runPublish() {
  if (publishInProgress) {
    publishRequestedAgain = true;
    return;
  }

  publishInProgress = true;
  try {
    publishInterface();
  } catch (error) {
    console.error('Live-Veröffentlichung fehlgeschlagen; die lokale Änderung bleibt erhalten:', error.message);
  } finally {
    publishInProgress = false;
    if (publishRequestedAgain) {
      publishRequestedAgain = false;
      schedulePublish();
    }
  }
}

function schedulePublish() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runPublish, debounceMs);
}

try {
  assertPublishTarget();
} catch (error) {
  if (error.code === 'ENOENT') {
    console.error('Live-Publisher konnte nicht starten: Git für Windows ist nicht installiert oder nicht im PATH.');
  } else {
    console.error(`Live-Publisher konnte nicht starten: ${error.message}`);
  }
  console.error('Richte Git für Windows, das öffentliche Repository und origin/main ein, bevor du den Publisher startest.');
  process.exitCode = 1;
} finally {
  if (!process.exitCode) {
    const watcher = fs.watch(projectRoot, { persistent: true }, (_eventType, filename) => {
      if (!filename || filename.toString().toLowerCase() === 'index.html') {
        console.log(`Änderung erkannt; Veröffentlichung startet nach ${debounceMs / 1000} Sekunden Ruhezeit.`);
        schedulePublish();
      }
    });

    watcher.on('error', (error) => {
      console.error('Dateiüberwachung fehlgeschlagen:', error);
      process.exitCode = 1;
      watcher.close();
    });
    console.log(`Überwache ${path.join(projectRoot, 'index.html')} für automatische Live-Veröffentlichungen.`);
    console.log('Es werden nur index.html-Änderungen nach erfolgreichem npm test zu GitHub übertragen.');
  }
}
