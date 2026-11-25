# Development and support

Use Node.js 24 or newer. Build and test from the repository root.

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run verify:bundle
node site/build.mjs --check
```

The loopback simulation exercises a Deep Search workflow without spending Buzz. GitHub Actions verifies the source and generated documentation. CodeQL and Dependabot results are available under repository security.

The 0.0.6 developer prerelease includes the reproducible Civitai source ZIP, its checksum, and the runtime software inventory. The release notes give the exact signature verification commands. [RasterRaid 0.0.6 developer prerelease](https://github.com/chriscollins500/rasterraid/releases/tag/v0.0.6)

Include the version and a public reproduction in an issue. Report vulnerabilities privately. [Build guide](https://chriscollins500.github.io/rasterraid/development/) · [Public issues](https://github.com/chriscollins500/rasterraid/issues/new/choose) · [Private vulnerability report](https://github.com/chriscollins500/rasterraid/security/advisories/new)
