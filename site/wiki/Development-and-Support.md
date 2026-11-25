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

The 0.0.9 developer prerelease includes the reproducible Civitai source ZIP, its checksum, and the runtime software inventory. The release notes give the signature verification commands for the exact tag and commit. [RasterRaid 0.0.9 developer prerelease](https://github.com/chriscollins500/rasterraid/releases/tag/v0.0.9)

The optional appearance model pack is pinned to the 0.0.8 release. [Model pack and license](https://github.com/chriscollins500/rasterraid/releases/tag/v0.0.8)

From the full repository checkout, use the hosted check to compare the expected bundle with the publication records and files serving on Civitai. [Hosted verification commands](https://chriscollins500.github.io/rasterraid/development/#hosted-build)

Include the version and a public reproduction in an issue. Report vulnerabilities privately. [Build guide](https://chriscollins500.github.io/rasterraid/development/) · [Public issues](https://github.com/chriscollins500/rasterraid/issues/new/choose) · [Private vulnerability report](https://github.com/chriscollins500/rasterraid/security/advisories/new)
