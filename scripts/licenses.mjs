// Generates src-tauri/licenses/THIRD-PARTY-NOTICES.txt (SPM-29): the licence
// texts for everything the v1 installer ships. Run after any Rust or npm
// dependency change:
//   node scripts/licenses.mjs   (or: bun run licenses)
// Offline and deterministic: cargo-about reads the local cargo registry
// (--offline), the ONNX Runtime and ISNet texts are vendored under
// src-tauri/licenses/vendor/, and npm texts come from node_modules.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = join(root, "src-tauri");
const vendorDir = join(tauriDir, "licenses", "vendor");
const outFile = join(tauriDir, "licenses", "THIRD-PARTY-NOTICES.txt");

const RULE = "=".repeat(80);
const SUBRULE = "-".repeat(80);

/** Reads a text file as UTF-8 with LF line endings and no trailing blank lines. */
function text(path) {
  return readFileSync(path, "utf8").replace(/\r\n?/g, "\n").trimEnd();
}

function section(title, body) {
  return `${RULE}\n${title}\n${RULE}\n\n${body}`;
}

function sub(title, body) {
  return `${SUBRULE}\n${title}\n\n${body}`;
}

// --- ONNX Runtime (statically linked via the `ort` crate, ADR-0006) -----------

// The version lives in vendor/README.md only, next to the texts it describes.
const onnxVersion = /^ONNX Runtime version: (\d+\.\d+\.\d+)\s*$/m.exec(text(join(vendorDir, "README.md")))?.[1];
if (!onnxVersion) throw new Error("src-tauri/licenses/vendor/README.md has no 'ONNX Runtime version: X.Y.Z' line");

const onnx = section(
  `ONNX RUNTIME ${onnxVersion} (Microsoft, MIT)`,
  [
    "Stickerpack Maker links ONNX Runtime statically (through the `ort` crate) for",
    "offline background removal. ONNX Runtime's own licence and third-party",
    "notices follow.",
    "",
    sub("ONNX Runtime licence", text(join(vendorDir, "onnxruntime-LICENSE"))),
    "",
    sub("ONNX Runtime third-party notices", text(join(vendorDir, "onnxruntime-ThirdPartyNotices.txt"))),
  ].join("\n"),
);

// --- ISNet model (downloaded on first use, not in the installer) ---------------

const isnet = section(
  "ISNET GENERAL-USE MODEL (Apache-2.0)",
  [
    "The background-removal model (ISNet, from the DIS project by Xuebin Qin and",
    "colleagues, https://github.com/xuebinqin/DIS) is not part of the installer.",
    "The app downloads it on first use from this project's own `models` GitHub",
    "release and runs it locally. It is licensed under the Apache License 2.0:",
    "",
    text(join(vendorDir, "isnet-dis-LICENSE.txt")),
  ].join("\n"),
);

// --- Fonts shipped in public/fonts ---------------------------------------------

const fontsDir = join(root, "public", "fonts");
const fonts = section(
  "BUNDLED EMOJI FONTS",
  [
    "Noto-COLRv1.ttf: Noto Color Emoji by Google, licensed under the SIL Open Font",
    "License 1.1.",
    "Twemoji_COLRv1.ttf: Twemoji graphics by the Twemoji project, licensed under",
    "CC-BY 4.0 (https://github.com/jdecked/twemoji).",
    "",
    sub("Noto Color Emoji: SIL Open Font License 1.1", text(join(fontsDir, "Noto-OFL.txt"))),
    "",
    sub("Twemoji: Creative Commons Attribution 4.0", text(join(fontsDir, "Twemoji-LICENSE-GRAPHICS.txt"))),
  ].join("\n"),
);

// --- npm packages bundled into the webview (runtime dependencies only) ---------

// A package that ships no licence text of its own borrows its sibling's: the
// Tauri JS plugins carry only an SPDX data file, and share the Tauri
// project's MIT / Apache-2.0 texts.
const BORROWED_LICENSE_FILES = {
  "@tauri-apps/plugin-dialog": "@tauri-apps/api",
};

function packageDir(name) {
  return join(root, "node_modules", ...name.split("/"));
}

function licenseFiles(name) {
  const dir = packageDir(name);
  const own = readdirSync(dir)
    .filter((f) => /^(license|licence)(?!.*\.spdx$)/i.test(f))
    .sort();
  if (own.length > 0) return own.map((f) => join(dir, f));
  const borrowed = BORROWED_LICENSE_FILES[name];
  if (borrowed) return licenseFiles(borrowed);
  throw new Error(`no licence file found for npm package ${name}; add it to BORROWED_LICENSE_FILES`);
}

/** Runtime dependency closure of package.json `dependencies`, sorted by name. */
function runtimePackages() {
  const seen = new Map();
  const visit = (name) => {
    if (seen.has(name)) return;
    const pkg = JSON.parse(readFileSync(join(packageDir(name), "package.json"), "utf8"));
    seen.set(name, pkg);
    for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep);
  };
  const own = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const name of Object.keys(own.dependencies ?? {})) visit(name);
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

const npm = section(
  "NPM PACKAGES (webview)",
  [
    "The packages below are bundled into the app's webview.",
    "",
    ...runtimePackages().flatMap(([name, pkg]) => {
      const texts = licenseFiles(name).map((f) => text(f));
      // Borrowed texts repeat the sibling's; each package still lists them so
      // its entry stands on its own.
      return [sub(`${name} ${pkg.version} (${pkg.license})`, texts.join("\n\n")), ""];
    }),
  ].join("\n").trimEnd(),
);

// --- Rust crates (cargo-about, Windows target) ---------------------------------

if (!existsSync(join(tauriDir, "about.hbs"))) throw new Error("src-tauri/about.hbs is missing");
const crates = execFileSync(
  "cargo",
  ["about", "generate", "--offline", "--manifest-path", join(tauriDir, "Cargo.toml"), "--config", join(tauriDir, "about.toml"), join(tauriDir, "about.hbs")],
  { cwd: tauriDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
).replace(/\r\n?/g, "\n").trimEnd();

// --- Assemble -------------------------------------------------------------------

const header = [
  RULE,
  "STICKERPACK MAKER: THIRD-PARTY NOTICES",
  RULE,
  "",
  "Stickerpack Maker itself is licensed under the MIT License (see LICENSE.txt).",
  "It includes or downloads the third-party components below, each under its own",
  "licence. Generated by `bun run licenses`; do not edit by hand.",
].join("\n");

const output = [header, onnx, isnet, fonts, npm, crates].join("\n\n") + "\n";
writeFileSync(outFile, output);
console.log(`wrote ${outFile} (${output.length} chars)`);
