# JS Studio Download Assistent

Der Windows-Downloadmanager lädt den Programmkatalog aus dem öffentlichen
Repository `Julianschneiderofficial/js-studio-download-assistent`. Namen,
Beschreibungen, Versionen, Dateigrößen und Versionshinweise werden aus dem
Katalog geladen; der Inhalt der Liste ist nicht auf eine feste Anzahl von
Programmen begrenzt.

Beim Start und beim erneuten Öffnen des Fensters wird der Assistent auf neue
Versionen geprüft. Der Katalog wird zusätzlich ungefähr jede Minute
aktualisiert. Hinweise nennen neue oder geänderte Programme, ihre Version,
Paketgröße und veröffentlichte Versionshinweise.

**Es wird nichts ungefragt aktualisiert.** Der Benutzer entscheidet selbst, ob
er einen Installer herunterlädt, startet, ein Programm aktualisiert oder
deinstalliert. Auch der Downloadmanager selbst aktualisiert sich nicht im
Hintergrund: Sein Installer wird heruntergeladen und erst nach ausdrücklicher
Bestätigung gestartet.

Die installierte Windows-Hülle lädt ihre Oberfläche aus GitHub Pages. Der
Workflow `.github/workflows/publish-live-ui.yml` testet und veröffentlicht
Änderungen an `index.html`; geöffnete Manager prüfen ungefähr jede Minute auf
eine neue Oberfläche und zeigen Veröffentlichungsdatum sowie
Änderungsnachricht. Der Beobachter `npm run live:publish` wartet 15 Sekunden
nach der letzten Änderung, führt `npm test` aus und überträgt nur `index.html`
über Git zum öffentlichen Branch `main`. GitHub Actions veröffentlicht die
Änderung anschließend auf Pages. Das Beobachterfenster muss laufen und Git
muss für das Repository angemeldet sein.

Damit sind nur Änderungen an der gehosteten Oberfläche live. Änderungen am
Electron-Hauptprozess, an IPC, Installer, Windows-Funktionen oder nativen
Teilen benötigen weiterhin einen neuen Manager-Build und Installer.

## Voraussetzungen

- Node.js 22 oder neuer
- npm
- Ein öffentliches GitHub-Repository für den Programmkatalog und die
  Release-Dateien

## Lokal testen und bauen

```powershell
npm ci
npm test
npm start
npm run dist
```

`npm run dist` erstellt den Windows-NSIS-Installer im Verzeichnis `dist`;
dieser Befehl veröffentlicht nichts auf GitHub.

## Einmalige Einrichtung der Live-Oberfläche

1. Erstelle und veröffentliche das öffentliche Repository
   `Julianschneiderofficial/js-studio-download-assistent`.
2. Öffne **Settings → Pages** und aktiviere **GitHub Actions** als
   Veröffentlichungsquelle.
3. Prüfe unter **Actions**, ob `Publish live manager interface` erfolgreich
   war. Die Oberfläche ist danach unter
   `https://julianschneiderofficial.github.io/js-studio-download-assistent/`
   erreichbar.
4. Melde Git für Windows einmal mit deinem GitHub-Konto an. Starte im
   Projektordner `npm run live:publish`; dieses Fenster bleibt beim
   Programmieren geöffnet. Änderungen an `index.html` werden nach 15 Sekunden
   Ruhezeit getestet, committet, gepusht und automatisch auf Pages
   veröffentlicht.
5. Installiere den neuen Manager-Installer einmal, damit die Windows-Hülle
   die gehostete Oberfläche lädt.

Danach veröffentlicht der Beobachter Änderungen an `index.html` ohne weitere
Veröffentlichungsklicks, sofern die Tests bestehen. Diese Änderungen gehen
öffentlich online. Veröffentliche keine Passwörter, persönlichen Daten oder
unfertigen/geheimen Inhalte.

## Produkte veröffentlichen

Für jedes Programm werden benötigt:

1. Eine Windows-Setup-EXE als Asset eines GitHub-Releases.
2. Eine dazugehörige, eigenständige Deinstaller-EXE als Release-Asset.
3. Ein Eintrag mit Name, Beschreibung, Version, Dateigröße,
   SHA-256-Prüfsumme und Versionshinweisen in `releases/products.json`.

Der Launcher prüft beide EXE-Dateien vor dem Start per SHA-256. Nach
erfolgreicher Installation speichert er die Version und die Informationen zum
Deinstaller. Ein neuerer Katalogstand kann dann als Update angezeigt werden.
Bei einem Update wird der neue Setup-Installer nur gestartet, nachdem der
Benutzer **Update installieren** gewählt hat. Zur Deinstallation lädt der
Launcher den zum installierten Stand gespeicherten Deinstaller herunter und
startet ihn erst nach Zustimmung.

Katalogänderungen erscheinen normalerweise innerhalb einer Minute im
geöffneten Launcher. Das Veröffentlichen von Quellcode allein erzeugt keinen
fertigen Produkt-Installer; diese Build- und Release-Schritte müssen für jedes
Programm eingerichtet werden.

## Downloadmanager veröffentlichen

Ein Versionstag wie `v1.0.3`, der zur Version in `package.json` passt, startet
den Workflow `.github/workflows/release.yml`. GitHub Actions baut den
Windows-Installer und veröffentlicht ihn samt `latest.yml` als GitHub-Release.
Der Manager zeigt eine neuere Version und deren Release-Informationen an,
lädt aber nichts automatisch herunter oder installiert etwas im Hintergrund.

Weitere Einrichtungs- und Manifestdetails stehen in
[RELEASES.md](./RELEASES.md).

## Windows-Signatur

Der Installer ist zurzeit nicht mit einem Codesigning-Zertifikat signiert;
SmartScreen kann daher eine Warnung anzeigen. Name und Symbol ersetzen keine
Authenticode-Signatur.
