const { readFile } = require("node:fs/promises");
const path = require("node:path");

const ALLOWED_TYPES = new Set(["program", "vst"]);

function validateCatalog(catalog) {
  if (!Array.isArray(catalog) || catalog.length > 500) {
    throw new Error("Der Software-Katalog hat ein ungültiges Format.");
  }

  const ids = new Set();
  return catalog.map((entry) => {
    if (
      !entry
      || typeof entry !== "object"
      || typeof entry.id !== "string"
      || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.id)
      || ids.has(entry.id)
      || typeof entry.name !== "string"
      || entry.name.length > 100
      || typeof entry.description !== "string"
      || entry.description.length > 500
      || typeof entry.version !== "string"
      || entry.version.length > 40
      || !ALLOWED_TYPES.has(entry.type)
      || typeof entry.installable !== "boolean"
    ) {
      throw new Error("Ein Eintrag im Software-Katalog ist ungültig.");
    }

    ids.add(entry.id);
    return {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      version: entry.version,
      type: entry.type,
      status: typeof entry.status === "string" ? entry.status.slice(0, 40) : "Verfügbar",
      logo: typeof entry.logo === "string" ? entry.logo.slice(0, 8) : "JS",
      installable: false,
      installationNote: entry.installable
        ? "Die Katalogdaten sind aktuell; ein Installationspaket ist in dieser App-Version noch nicht aktiviert."
        : "Platzhalter: Es ist noch kein Installationspaket hinterlegt."
    };
  });
}

async function listPrograms(coreDirectory) {
  const catalogPath = path.join(coreDirectory, "catalog.json");
  let catalog;
  try {
    catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  } catch (error) {
    throw new Error(`Der Software-Katalog konnte nicht geladen werden: ${error.message}`);
  }
  return validateCatalog(catalog);
}

function findProgram(programId, catalog) {
  if (typeof programId !== "string") {
    throw new TypeError("Die Programmkennung muss eine Zeichenkette sein.");
  }
  const program = catalog.find((entry) => entry.id === programId);
  if (!program) {
    throw new Error("Das angeforderte Programm ist nicht im Katalog.");
  }
  return program;
}

function assertInstallable(programId, catalog) {
  const program = findProgram(programId, catalog);
  throw new Error(`${program.name}: Für diesen Katalogeintrag ist noch kein geprüftes Installationsverfahren konfiguriert.`);
}

module.exports = {
  assertInstallable,
  listPrograms
};
