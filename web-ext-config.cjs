// Exclude development files from packaging and linting. The package contains
// manifest.json, src/, and the required Apache license copy.
//
// web-ext does not read .gitignore. Explicitly exclude scratch/ because it
// contains private advisory captures and repository history backups.

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
