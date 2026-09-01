// What web-ext leaves out of the package it builds, and out of what it lints.
//
// The extension is manifest.json and src/. LICENSE ships with it because the
// Apache License asks that a copy travel with the work. Everything else in this
// repository is development material: the tests and their fixtures, the capture
// and icon tools, the type declarations, the documentation, and the working
// notes under scratch/.
//
// web-ext does not read .gitignore, so scratch/ is named here as well. It holds
// captures of real advisories and backups of this repository's history, and a
// package carrying it would publish both.

module.exports = {
  ignoreFiles: [
    'scratch',
    'test',
    'test-support',
    'testdata',
    'tools',
    'types',
    'docs',
    'CLAUDE.md',
    'PRIVACY.md',
    'README.md',
    'REQUIREMENTS.md',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'web-ext-config.cjs',
  ],
};
