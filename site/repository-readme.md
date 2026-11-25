# RasterRaid

RasterRaid is a native Civitai search app. Start with a model name, a description, a picture or an exact link. Compare releases, follow the recorded sources and combine your results into a report.

[Website](https://chriscollins500.github.io/rasterraid/) · [Getting started](https://chriscollins500.github.io/rasterraid/guide/) · [Search coverage](https://chriscollins500.github.io/rasterraid/coverage/) · [Wiki](https://github.com/chriscollins500/rasterraid/wiki) · [Support](https://chriscollins500.github.io/rasterraid/support/)

## Developer preview

The 0.0.7 developer prerelease adds checks for restrictive model and media filters, exact model evidence across gallery posts, and a way to verify the deployed build. The earlier 0.0.4 build is in Civitai review for both domains. [Download and verify 0.0.7](https://github.com/chriscollins500/rasterraid/releases/tag/v0.0.7) · [Current Civitai availability](https://chriscollins500.github.io/rasterraid/releases/)

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

### Verify a Civitai deployment

From the expected release source, build the app and save its bundle receipt. Run the hosted check with the official CLI signed in to the app owner account.

```sh
npm run build
npm run --silent verify:bundle | npm run --silent verify:hosted -- /path/to/civitai
```

For earlier releases, pass their bundle receipt to the command from the current checkout. The check reads both Civitai submission records and public listings, compares the expected files with the serving app, and confirms the serving records again. A successful check verifies deployment identity and bundle contents. Use browser qualification for viewer access and app behavior.

## Project checks and documentation

GitHub Actions checks supported Node versions, the built app and the generated site. Dependabot tracks npm and GitHub Actions. CodeQL results are available from the repository’s Security tab.

```sh
node site/build.mjs
node site/build.mjs --check
```

[Contributing](CONTRIBUTING.md) · [Report a vulnerability](SECURITY.md) · [Get help](https://chriscollins500.github.io/rasterraid/support/)
