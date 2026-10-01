const packageJson = require('../package.json');

const tag = process.env.GITHUB_REF_NAME;
if (!tag) {
  console.error('GITHUB_REF_NAME fehlt; der Workflow muss für einen Versionstag laufen.');
  process.exit(1);
}

if (tag !== `v${packageJson.version}`) {
  console.error(`Release-Tag ${tag} stimmt nicht mit package.json-Version v${packageJson.version} überein.`);
  process.exit(1);
}

console.log(`Release-Tag und Paketversion stimmen überein: ${tag}.`);
