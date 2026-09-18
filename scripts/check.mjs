import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, pkg.version);
assert.deepEqual(manifest.permissions, ["storage"]);
for (const file of [manifest.background.service_worker, manifest.options_ui.page,
  ...manifest.content_scripts.flatMap(script => [...script.js, ...script.css])]) assert.ok(existsSync(file), file);
for (const file of ["background.js", "content.js", "options.js", "questions.js"]) execFileSync(process.execPath, ["--check", file]);
console.log("Manifest, versions, extension files, and JavaScript syntax verified.");
