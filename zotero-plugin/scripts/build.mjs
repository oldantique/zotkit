import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(repo, "build");
const root = path.join(buildDir, "xpi-root");
const content = path.join(root, "chrome", "content");
const dist = path.join(repo, "dist");

async function copy(source, target) {
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
}

async function ensureNativeHelper() {
  const source = path.join(repo, "native", "dist", "zoterochat-helper");
  const implementation = path.join(repo, "native", "src", "zoterochat_helper.c");
  try {
    const [binaryStat, sourceStat] = await Promise.all([stat(source), stat(implementation)]);
    if (binaryStat.mtimeMs < sourceStat.mtimeMs) throw new Error("native helper is stale");
  }
  catch {
    execFileSync("make", ["-C", path.join(repo, "native"), "universal"], {
      stdio: "inherit"
    });
  }
  return source;
}

await rm(root, { recursive: true, force: true });
await mkdir(content, { recursive: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [path.join(repo, "src", "index.ts")],
  outfile: path.join(content, "zoterochat.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "ZoteroChatBundle",
  target: ["firefox140"],
  sourcemap: false,
  minify: false,
  legalComments: "none",
  assetNames: "fonts/[name]-[hash]",
  loader: {
    ".svg": "dataurl",
    ".woff2": "file",
    ".woff": "file",
    ".ttf": "file"
  }
});

const helper = await ensureNativeHelper();
await Promise.all([
  copy(path.join(repo, "manifest.json"), path.join(root, "manifest.json")),
  copy(path.join(repo, "THIRD_PARTY_NOTICES.txt"), path.join(root, "THIRD_PARTY_NOTICES.txt")),
  copy(path.join(repo, "bootstrap.js"), path.join(root, "bootstrap.js")),
  copy(path.join(repo, "prefs.js"), path.join(root, "prefs.js")),
  copy(path.join(repo, "assets"), path.join(content, "icons")),
  copy(path.join(repo, "locale"), path.join(root, "locale")),
  copy(helper, path.join(root, "native", "zoterochat-helper"))
]);

const helperBytes = await readFile(helper);
const integrity = {
  algorithm: "sha256",
  digest: createHash("sha256").update(helperBytes).digest("hex")
};
await writeFile(
  path.join(root, "native", "integrity.json"),
  JSON.stringify(integrity, null, 2) + "\n"
);

const manifest = JSON.parse(await readFile(path.join(repo, "manifest.json"), "utf8"));
const xpiName = `Zotkit-${manifest.version}.xpi`;
const xpiPath = path.join(dist, xpiName);
await rm(xpiPath, { force: true });
execFileSync("/usr/bin/zip", ["-X", "-q", "-r", xpiPath, "."], {
  cwd: root,
  stdio: "inherit"
});

const xpiBytes = await readFile(xpiPath);
const sha256 = createHash("sha256").update(xpiBytes).digest("hex");
await writeFile(path.join(dist, `${xpiName}.sha256`), `${sha256}  ${xpiName}\n`);
process.stdout.write(`${xpiPath}\nSHA-256 ${sha256}\n`);
