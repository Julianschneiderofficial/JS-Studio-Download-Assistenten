# GitHub-Katalog, Installationen und manuelle Updates

## Öffentliches GitHub-Repository

Der Launcher verwendet das öffentliche Repository
`Julianschneiderofficial/js-studio-download-assistent`. Der Katalog liegt unter
`releases/products.json` im Branch `main`; Programmdateien und
Downloadmanager-Releases liegen als GitHub-Release-Assets vor. Es ist kein
GitHub-Zugriffstoken im Programm eingebettet.

Das Repository muss öffentlich sein, damit der Katalog und die Installer ohne
Anmeldung erreichbar sind. Quellcode und veröffentlichte Dateien sind damit
ebenfalls öffentlich. Veröffentliche dort keine privaten Dateien,
Zugangsdaten oder Geheimnisse.

## Live-Oberfläche automatisch veröffentlichen

Die installierte Windows-Hülle lädt die Manager-Oberfläche über
`https://julianschneiderofficial.github.io/js-studio-download-assistent/`.
`.github/workflows/publish-live-ui.yml` testet und veröffentlicht `index.html`
bei Änderungen auf `main`. Die Seite enthält `build-info.json` mit
Veröffentlichungszeit, Commit-ID und Commit-Nachricht. Geöffnete Fenster prüfen
die veröffentlichte Version jede Minute und laden eine neue Oberfläche
automatisch nach. Der Hinweis zeigt Datum und Commit-Nachricht.

Für automatisches Veröffentlichen direkt nach dem Bearbeiten richte es einmal
ein:

1. Veröffentliche das Repository und aktiviere unter **Settings → Pages** die
   Quelle **GitHub Actions**.
2. Installiere Git für Windows und melde es über GitHub Desktop einmal mit dem
   Zielkonto an. Das Repository muss unter `main` mit dem korrekten Remote
   `origin` eingerichtet sein.
3. Starte im Projektordner `npm run live:publish`; lasse das Fenster während
   des Programmierens geöffnet. Der Beobachter reagiert nur auf Änderungen an
   `index.html`, wartet 15 Sekunden nach der letzten Änderung, führt `npm test`
   aus und committet/pusht danach ausschließlich diese Datei.
4. GitHub Actions stellt den Push automatisch auf Pages bereit. Der
   Windows-Manager selbst braucht für eine `index.html`-Änderung keinen neuen
   Installer.

Die Veröffentlichung ist öffentlich. Bei fehlgeschlagenen Tests oder fehlender
GitHub-Verbindung bleibt die Änderung lokal und wird nicht gepusht. Änderungen
an `main.js`, `preload.js`, nativen Windows-Funktionen oder am Installer können
nicht über die Live-Seite übernommen werden und benötigen weiterhin einen
neuen Windows-Build.

1. Lege unter dem GitHub-Konto `Julianschneiderofficial` ein öffentliches
   Repository namens `js-studio-download-assistent` an.
2. Füge den vorhandenen Ordner `JS Studio Download Assistenten` in
   GitHub Desktop als Repository hinzu. Wähle gegebenenfalls **Create a
   repository here**.
3. Veröffentliche den Branch `main`.
4. Prüfe, dass `releases/products.json`, `.github/workflows/ci.yml` und
   `.github/workflows/release.yml` vorhanden sind. CI testet den Code und baut
   Windows-Installer; der Release-Workflow veröffentlicht den Downloadmanager
   bei Versions-Tags.

## Programm installieren, aktualisieren und deinstallieren

### Voraussetzungen für jedes Programm

Der Katalog ist dynamisch; Produkt-IDs bestehen aus Kleinbuchstaben, Ziffern
und Bindestrichen. Für einen benutzbaren Programmeintrag werden zwei
eigenständige Windows-Programme benötigt:

- Der Setup-Installer installiert das Programm und führt bei erneutem Start
  eine Aktualisierung der vorhandenen Installation aus.
- Der zum installierten Stand gehörende Deinstaller entfernt diese Installation.
  Er muss Daten, die der Benutzer behalten soll, erhalten oder ausdrücklich
  abfragen. Der Launcher löscht keine fremden Programmordner selbst.

Lade Setup und Deinstaller als Assets eines Releases im konfigurierten
GitHub-Repository hoch. Berechne Größe und SHA-256 in PowerShell:

```powershell
(Get-Item .\aufnahme-1.0.0-setup.exe).Length
(Get-FileHash -Algorithm SHA256 .\aufnahme-1.0.0-setup.exe).Hash.ToLower()
(Get-Item .\aufnahme-1.0.0-uninstall.exe).Length
(Get-FileHash -Algorithm SHA256 .\aufnahme-1.0.0-uninstall.exe).Hash.ToLower()
```

Ergänze anschließend `releases/products.json`:

```json
{
  "schemaVersion": 1,
  "products": {
    "aufnahme": {
      "name": "JS Studio Aufnahme Programm",
      "description": "Audioaufnahme",
      "version": "1.0.0",
      "sizeBytes": 23456789,
      "downloadUrl": "https://github.com/Julianschneiderofficial/js-studio-download-assistent/releases/download/aufnahme-v1.0.0/aufnahme-1.0.0-setup.exe",
      "sha256": "64_STELLIGE_SHA256_DER_SETUP_DATEI",
      "releaseNotes": "Neu: Aufnahmeprofile; verbessert: Stabilität.",
      "uninstaller": {
        "downloadUrl": "https://github.com/Julianschneiderofficial/js-studio-download-assistent/releases/download/aufnahme-v1.0.0/aufnahme-1.0.0-uninstall.exe",
        "sizeBytes": 3456789,
        "sha256": "64_STELLIGE_SHA256_DES_DEINSTALLERS"
      }
    }
  }
}
```

Ersetze Größen und Hashwerte durch die tatsächlichen Ausgaben. Lade danach das
geänderte Manifest nach `main`. Der Launcher fragt den Katalog beim Start und
beim Fokus erneut sowie ungefähr jede Minute ab.

### Verhalten im Launcher

- **Installieren:** lädt den Setup-Installer, prüft HTTPS-Quelle, exakte
  Dateigröße und SHA-256 und startet ihn nach der Auswahl des Benutzers.
- **Update installieren:** erscheint nur, wenn eine höhere Katalogversion als
  die lokal installierte Version veröffentlicht ist. Der Benutzer startet den
  Setup-Installer selbst; es gibt keine stille Aktualisierung.
- **Deinstallieren:** lädt den bei der Installation gespeicherten
  Produkt-Deinstaller, prüft Größe und SHA-256 und startet ihn nach der
  Bestätigung. Nach einem erfolgreichen Abschlusscode wird das Produkt als
  deinstalliert markiert.
- **Was ist neu?:** `releaseNotes` wird am Produkteintrag angezeigt. Nachrichten
  über neu hinzugefügte oder geänderte Produkte nennen Version und Paketgröße.

Jeder erfolgreich installierte Stand speichert die URL, Größe und Prüfsumme
seines Deinstallers lokal. Dadurch bleibt der richtige Deinstaller verfügbar,
auch wenn das Programm später aus dem aktuellen Katalog entfernt wird. Ältere
Installationen aus früheren Launcher-Versionen haben diese Information unter
Umständen nicht; für sie wird die Schaltfläche deaktiviert und auf Windows
**Installierte Apps** verwiesen.

## Downloadmanager-Updates

Der Workflow `.github/workflows/release.yml` veröffentlicht den Windows-Installer
und `latest.yml`, wenn ein Tag wie `v1.0.3` zum Wert in `package.json` passt.
Der Workflow verwendet `GITHUB_TOKEN` mit `contents: write`; kein persönlicher
Zugriffstoken ist nötig.

Der Downloadmanager prüft beim Start auf eine neuere stabile GitHub-Version und
zeigt Version, Release-Text und Dateigröße. **Updates werden nicht automatisch
installiert:** Der Benutzer wählt erst **Update herunterladen** und danach
**Installer starten**. Die Datei wird vor dem Start mit dem SHA-512-Wert und der
Größe aus `latest.yml` geprüft. Für das Installieren wird der Assistent
geschlossen und der integritätsgeprüfte GitHub-Release-Installer gestartet.

Zum Veröffentlichen einer neuen Manager-Version:

1. Erhöhe die Version in `package.json` (beispielsweise `1.0.2`).
2. Veröffentliche die Änderung auf `main`.
3. Erstelle den dazu passenden Tag `v1.0.2` auf demselben Commit und pushe ihn.
4. Prüfe unter **Actions**, ob `Publish Windows release` erfolgreich war und
   das GitHub-Release die Setup-EXE sowie `latest.yml` enthält.

Ein installiertes Programm aktualisiert den Launcher selbst nicht. Wer eine
Version ohne Updatefunktion verwendet, muss den neuen Installer manuell
herunterladen und starten.

## Sicherheit und Grenzen

- Manifest, Setup- und Deinstaller-Dateien müssen aus dem konfigurierten
  öffentlichen GitHub-Repository stammen und per HTTPS geladen werden.
- Die vollständige Dateigröße und SHA-256-Prüfsumme werden vor dem Start jedes
  Programm-Setup- oder Deinstallers geprüft; Manager-Updates verwenden SHA-512.
- Ein öffentliches Repository bedeutet, dass jeder die Dateien herunterladen
  kann. Schütze dein GitHub-Konto und aktiviere Zwei-Faktor-Authentifizierung.
- Die Windows-Installer sind derzeit nicht mit einem Authenticode-Zertifikat
  signiert. SmartScreen kann daher **Unbekannter Herausgeber** anzeigen.
- Für die ursprünglich vorgesehenen JS-Studio-Programme liegen noch keine
  fertigen Installer vor. Die Installations-, Update- und
  Deinstallationsaktionen für ein Programm sind erst aktiv, nachdem Setup,
  Deinstaller, Release-Asset und gültiger Manifest-Eintrag veröffentlicht sind.
