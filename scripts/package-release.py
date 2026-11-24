"""Build and independently audit the local Civitai source ZIP."""

import argparse
from datetime import UTC, datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]
BUILD_FILES = ("block.manifest.json", "package.json", "package-lock.json", "scripts/assets.mjs", "scripts/build.mjs")
ZIP_EPOCH = 946684800  # 2000-01-01 UTC, within ZIP's timestamp range.
MAX_FILE_BYTES = 2_000_000
SENSITIVE_TEXT = (
    re.compile(rb"\beyJ[\w-]{20,}\.[\w-]{20,}\.[\w-]{20,}\b"),
    re.compile(rb"-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----"),
    re.compile(rb"\b[A-Za-z]:[\\/]Users[\\/]", re.IGNORECASE),
)


def run(args, cwd=ROOT):
    return subprocess.run(
        [str(arg) for arg in args],
        cwd=cwd,
        env={**os.environ, "NODE_USE_SYSTEM_CA": "1"},
        capture_output=True,
        check=True,
        encoding="utf-8",
        timeout=60,
    ).stdout


def digest(value):
    return hashlib.sha256(value).hexdigest()


def tool(name):
    path = shutil.which(name)
    if not path:
        raise ValueError(f"{name} is required on PATH.")
    return Path(path)


def read_regular(directory, name):
    relative = PurePosixPath(name)
    if str(relative) != name or relative.is_absolute() or any(
        not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", part) for part in relative.parts
    ) or not relative.parts:
        raise ValueError(f"Unexpected release path: {name}")
    path = directory.joinpath(*relative.parts)
    info = path.lstat()
    if not path.resolve().is_relative_to(directory.resolve()) or not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE_BYTES:
        raise ValueError(f"Expected a bounded regular release file: {name}")
    payload = path.read_bytes()
    if any(pattern.search(payload) for pattern in SENSITIVE_TEXT):
        raise ValueError(f"Sensitive data pattern in release file: {name}")
    return payload


def inputs(node):
    routes = json.loads(run([node, "--input-type=module", "--eval",
        "import { previewFiles } from './scripts/assets.mjs'; console.log(JSON.stringify(Object.keys(previewFiles)));"]))
    if not routes or any(not isinstance(route, str) or not route.startswith("/") for route in routes):
        raise ValueError("Invalid static asset manifest.")
    assets = [route[1:] for route in routes]
    files = (*assets, *BUILD_FILES)
    if len(set(files)) != len(files) or len({name.casefold() for name in files}) != len(files):
        raise ValueError("Duplicate release path.")
    return assets, {name: read_regular(ROOT, name) for name in sorted(files)}


def write_source(directory, files):
    directory.mkdir()
    for name, payload in files.items():
        path = directory.joinpath(*PurePosixPath(name).parts)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        os.utime(path, (ZIP_EPOCH, ZIP_EPOCH))


def checked_zip(archive, expected):
    with zipfile.ZipFile(archive) as bundle:
        members = bundle.infolist()
        names = [entry.filename for entry in members]
        if len(set(names)) != len(names) or set(names) != set(expected):
            raise ValueError("ZIP contents differ from the release file list.")
        contents = {}
        for entry in members:
            name = entry.filename
            mode = stat.S_IFMT(entry.external_attr >> 16)
            if mode not in (0, stat.S_IFREG) or entry.is_dir() or entry.file_size != len(expected[name]):
                raise ValueError(f"Unexpected archive member type or size: {name}")
            payload = bundle.read(entry)  # zipfile also verifies the member CRC.
            if payload != expected[name]:
                raise ValueError(f"Archive member differs from source: {name}")
            contents[name] = payload
    return contents


def built_snapshot(directory, assets, expected):
    found = {path.relative_to(directory).as_posix() for path in directory.rglob("*") if not path.is_dir()}
    if found != set(assets):
        raise ValueError("Built output differs from the static asset list.")
    sha = hashlib.sha256()
    for name in assets:
        payload = read_regular(directory, name)
        if payload != expected[name]:
            raise ValueError(f"Built asset differs from the audited ZIP: {name}")
        sha.update(("/" + name + "\0").encode())
        sha.update(payload)
    return sha.hexdigest()


def write_json(path, data):
    return path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def subject_dependencies(sbom, node, rebuilt):
    pins = json.loads(run([node, "--input-type=module", "--eval",
        "import {subjectVisionModel,subjectWasm} from './src/subject-artifacts.mjs'; "
        "console.log(JSON.stringify({model:subjectVisionModel,wasm:subjectWasm}));"], rebuilt))
    runtime_version = re.search(r"/onnxruntime-web@([0-9.]+)/dist/", pins["wasm"]["url"])[1]
    model_revision = re.search(r"/resolve/([0-9a-f]{40})/", pins["model"]["url"])[1]
    runtime = f"pkg:npm/onnxruntime-web@{runtime_version}"
    model = f"siglip2-vision-q4@{model_revision}"
    wasm = f"ort-jspi-wasm@{runtime_version}"
    sbom["components"].append({
        "bom-ref": runtime, "type": "library", "name": "onnxruntime-web", "version": runtime_version,
        "scope": "optional", "purl": runtime, "licenses": [{"license": {"id": "MIT"}}],
        "description": "Bundled JSPI JavaScript with the static Emscripten binding.",
        "externalReferences": [{"type": "website", "url": "https://onnxruntime.ai/"}],
    })
    for key, ref, classification, name, version in [
        ("wasm", wasm, "file", "ort-wasm-simd-threaded.jspi.wasm", runtime_version),
        ("model", model, "machine-learning-model", "SigLIP 2 Base Patch16-224 Q4 vision ONNX", model_revision),
    ]:
        artifact = pins[key]
        sbom["components"].append({
            "bom-ref": ref, "type": classification, "name": name, "version": version, "scope": "optional",
            "hashes": [{"alg": "SHA-256", "content": artifact["sha256"]}],
            "externalReferences": [{"type": "distribution", "url": artifact["url"]}],
            "description": f"Browser download after opt-in. Exact size {artifact['bytes']} bytes.",
        })
    app_ref = sbom["metadata"]["component"]["bom-ref"]
    app_edges = next(edge for edge in sbom["dependencies"] if edge["ref"] == app_ref)
    app_edges["dependsOn"].extend([runtime, model])
    sbom["dependencies"].extend([{"ref": runtime, "dependsOn": [wasm]}, {"ref": wasm, "dependsOn": []},
                                 {"ref": model, "dependsOn": []}])


def package(cli, node, npm, assets, expected):
    start = datetime.now(UTC).isoformat()
    manifest = json.loads(expected["block.manifest.json"])
    pkg = json.loads(expected["package.json"])
    app, version = manifest["blockId"], manifest["version"]
    if not all(re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,63}", value) for value in (app, version)):
        raise ValueError("Invalid App name or version.")
    if manifest["buildCommand"] != "npm run build" or manifest["outputDir"] != "dist" or pkg["version"] != version:
        raise ValueError("The release build command, output directory, or version changed.")
    active_sha = built_snapshot(ROOT / "dist", assets, expected)
    temporary = ROOT / ".tmp"
    temporary.mkdir(exist_ok=True)
    if temporary.resolve() != temporary:
        raise ValueError("Use the workspace's own temporary directory for staging.")
    output = Path(tempfile.mkdtemp(prefix=f"{app}-{version}-release-", dir=temporary))
    archive = output / f"{app}-{version}-civitai-source.zip"
    repeat = output / "reproducibility.zip"
    flags = [cli, "--no-color", "--no-update-check", "app"]
    for source, dest in [("source", archive), ("repeat-source", repeat)]:
        staging = output / source
        write_source(staging, expected)
        run([*flags, "validate", "--strict", "."], staging)
        run([*flags, "submit", "--package-only", "--out", dest, "."], staging)
    unzipped = checked_zip(archive, expected)
    checked_zip(repeat, expected)
    archive_hash = digest(archive.read_bytes())
    if digest(repeat.read_bytes()) != archive_hash:
        raise ValueError("The two official ZIP files differ.")

    # npm uses the rebuild directory name for the SBOM root component.
    rebuilt = output / app
    write_source(rebuilt, unzipped)
    run([npm, "run", "build"], rebuilt)
    rebuilt_sha = built_snapshot(rebuilt / "dist", assets, unzipped)
    if active_sha != rebuilt_sha:
        raise ValueError("The rebuild from the ZIP differs from the workspace build.")

    sbom = json.loads(run([npm, "sbom", "--package-lock-only", "--omit=dev", "--sbom-format=cyclonedx"], rebuilt))
    component = sbom.get("metadata", {}).get("component", {})
    if sbom.get("bomFormat") != "CycloneDX" or (
        component.get("name"), component.get("version"), component.get("purl")
    ) != (app, version, f"pkg:npm/{app}@{version}"):
        raise ValueError("The runtime SBOM did not match the audited App version.")
    npm_runtime_dependencies = len(sbom["components"])
    subject_dependencies(sbom, node, rebuilt)
    audit = json.loads(run([npm, "audit", "--package-lock-only", "--omit=dev", "--json"], rebuilt))
    toolchain = {"civitai": run([cli, "--no-color", "--no-update-check", "--version"]).strip(),
        "node": run([node, "--version"]).strip(), "npm": run([npm, "--version"]).strip(), "python": sys.version.split()[0]}
    members = [{"name": name, "bytes": len(payload), "sha256": digest(payload)} for name, payload in expected.items()]
    receipt = {"app": app, "version": version, "archive": archive.name, "archiveBytes": archive.stat().st_size,
        "archiveSha256": archive_hash, "sourceEntries": len(members), "assets": len(assets), "snapshotSha256": rebuilt_sha,
        "sourceFiles": members, "reproducedArchive": True, "rebuiltFromZip": True, "toolchain": toolchain,
        "civitaiExecutableSha256": digest(cli.read_bytes()), "productionDependencies": len(sbom["components"]),
        "npmRuntimeDependencies": npm_runtime_dependencies,
        "signatureVerified": False}
    write_json(output / "package-verification.json", receipt)
    write_json(output / "runtime-sbom.cdx.json", sbom)
    write_json(output / "npm-audit.json", audit)
    (output / "SHA256SUMS.txt").write_text(f"{archive_hash}  {archive.name}\n", encoding="utf-8")
    write_json(output / "build-provenance.json", {
        "_type": "https://in-toto.io/Statement/v1", "subject": [{"name": archive.name, "digest": {"sha256": archive_hash}}],
        "predicateType": "https://slsa.dev/provenance/v1",
        "predicate": {"buildDefinition": {"buildType": "urn:rasterraid:civitai-source-package:v1",
            "externalParameters": {"app": app, "version": version, "buildCommand": manifest["buildCommand"]},
            "internalParameters": {"zipFileTimeEpoch": ZIP_EPOCH},
            "resolvedDependencies": [{"name": row["name"], "digest": {"sha256": row["sha256"]}} for row in members]},
            "runDetails": {"builder": {"id": "urn:rasterraid:local-build", "version": toolchain},
                "metadata": {"startedOn": start, "finishedOn": datetime.now(UTC).isoformat()},
                "byproducts": [{"name": "package-verification.json",
                    "digest": {"sha256": digest((output / "package-verification.json").read_bytes())}}]}},
    })
    print(json.dumps({"releaseFolder": output.as_posix(), "archive": archive.as_posix(), "rebuiltDirectory": (rebuilt / "dist").as_posix(),
        **{key: value for key, value in receipt.items() if key not in {"sourceFiles", "archive"}}}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--civitai", type=Path, help="Path to the installed official Civitai CLI")
    parser.add_argument("--check", type=Path, help="Compare ZIP entries with current source without running the archive")
    args = parser.parse_args()
    node = tool("node")
    assets, expected = inputs(node)
    if args.check:
        checked_zip(args.check, expected)
        print(f"Verified all {len(expected)} members and CRCs.")
    else:
        cli = args.civitai.resolve(strict=True) if args.civitai else tool("civitai")
        package(cli, node, tool("npm"), assets, expected)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
