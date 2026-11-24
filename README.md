# RasterRaid

RasterRaid is a native Civitai search app. Start with a model name, a description, a picture or an exact link. Compare releases, follow the recorded sources and combine your results into a report.

[Website](https://chriscollins500.github.io/rasterraid/) · [Getting started](https://chriscollins500.github.io/rasterraid/guide/) · [Search coverage](https://chriscollins500.github.io/rasterraid/coverage/) · [Wiki](https://github.com/chriscollins500/rasterraid/wiki) · [Support](https://chriscollins500.github.io/rasterraid/support/)

## Developer preview

Version 0.0.4 was checked in signed developer frames on `civitai.com` and `civitai.red`. Free search and live Deep Search quotes are available in those previews. Public execution depends on Civitai review and deployment. [Current availability](https://chriscollins500.github.io/rasterraid/releases/)

## Run locally

Use Node.js 24 or newer. RasterRaid uses native browser modules and has no runtime npm packages.

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run verify:bundle
npm run dev -- 5188 dist --mock-deep-search
```

Open `http://127.0.0.1:5188/mock-deep-search`. The Linocut example lets you try search, comparison and a complete simulated Deep Search run with 0 Buzz.

## Civitai package

Use the official Civitai CLI to validate and package the native app. The command below builds and verifies the source archive locally.

```sh
python scripts/package-release.py --civitai /path/to/civitai
```

The build keeps Civitai’s iframe sandbox, validates platform permissions and writes a private receipt before sending a workflow. [Deep Search and Buzz](https://chriscollins500.github.io/rasterraid/deep-search/) · [Privacy and permissions](https://chriscollins500.github.io/rasterraid/privacy/)

## Project checks and documentation

GitHub Actions checks supported Node versions, the built app and the generated site. Dependabot tracks npm and GitHub Actions. CodeQL results are available from the repository’s Security tab.

```sh
node site/build.mjs
node site/build.mjs --check
```

[Contributing](CONTRIBUTING.md) · [Report a vulnerability](SECURITY.md) · [Get help](https://chriscollins500.github.io/rasterraid/support/)
