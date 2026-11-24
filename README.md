# RasterRaid

RasterRaid is a native Civitai search app. Start with a model name, a description, a picture or an exact link. Compare releases, follow the recorded sources and combine your results into a report.

[Website](https://chriscollins500.github.io/rasterraid/) · [Getting started](https://chriscollins500.github.io/rasterraid/guide/) · [Search coverage](https://chriscollins500.github.io/rasterraid/coverage/) · [Wiki](https://github.com/chriscollins500/rasterraid/wiki) · [Support](https://chriscollins500.github.io/rasterraid/support/)

## Developer preview

The audited developer build was checked in signed frames on `civitai.com` and `civitai.red`. Its fixes cover live filter retirement, dialog controls, and Deep Search picture, clip, and audio evidence. The signed GitHub v0.0.4 archive preserves the earlier build. Public execution depends on Civitai review and deployment. [Current availability and verified builds](https://chriscollins500.github.io/rasterraid/releases/)

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

## On-device subject matching

**Find the same subject** compares up to six eligible public previews against a whole picture or video poster in supported browsers. It uses WebGPU with JavaScript Promise Integration when available and runs the same model with single-threaded WebAssembly SIMD otherwise. Selecting **Compare on this device** downloads about 78–81 MB of pinned model and runtime files, verifies their hashes, and compares the previews in a local worker. RasterRaid sends no preview pixels or local ranks to the binary hosts. The regular appearance results stay available.

The first comparison shows download progress. Subsequent comparisons in the same tab can reuse the loaded model for up to two minutes between uses. Each comparison revalidates public preview requests and analyzes the reference again. The worker can reuse analysis for up to 24 eligible public previews whose decoded pixels match. The app releases the worker and its cache when you leave the page, when the idle tab is hidden, or when viewing access changes.

When both free rankings cover the same whole previews, Deep Search can quote a four-preview shortlist alongside the full comparison. The paid request uses only the shortlisted public Civitai URLs and catalog associations. The result can show both free ranks for that same set of previews.

You can also add a picture from your device, search by reference, and run the subject comparison on the gallery results. A selected area stays part of the comparison. If you add several positive local references, choose which one supplies the subject. Deep Search can describe the top public matches and use your written search as context. Your local file, filename, metadata, crop coordinates, and scores stay in your browser.

RasterRaid pins ONNX Runtime Web 1.31.1 and Google's SigLIP 2 Q4 ONNX vision export. The bundled JavaScript preserves the MIT-licensed runtime and replaces dynamic binding generation with static calls. The build checks the three vendor hashes. [Browser binary pins](src/subject-artifacts.mjs) · [Third-party notices](src/vendor/ort/LICENSE.txt)

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
