import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { exportCommand } from "../src/commands/export.js";
import { DECK_SCHEMA } from "@55aaseclab/lattice-runtime";

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "export-project");
const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tempRoots = [];

const tmpProject = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-export-"));
  tempRoots.push(dir);
  return dir;
};

test("exportCommand produces a complete, schema-valid static deck artifact", async () => {
  const out = path.join(tmpProject(), "good");
  try {
    await exportCommand({ args: { deck: "good", out }, cwd: fixtureDir });

    for (const entry of ["index.html", "manifest.json", "content.json", "layout.json", "notes.json"]) {
      assert.equal(fs.existsSync(path.join(out, entry)), true, `${entry} missing`);
    }
    assert.equal(fs.existsSync(path.join(out, "assets", "logo.svg")), true, "deck asset not copied");
    const bundledCss = fs.readdirSync(path.join(out, "assets")).find((file) => file.endsWith(".css"));
    assert.ok(bundledCss, "bundled runtime css missing");
    assert.ok(fs.readdirSync(path.join(out, "assets")).some((file) => file.endsWith(".js")), "bundled runtime js missing");

    const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
    assert.equal(manifest.schema, DECK_SCHEMA);
    assert.equal(manifest.id, "good");
    assert.equal(manifest.runtime, "0.2.0");
    const content = JSON.parse(fs.readFileSync(path.join(out, "content.json"), "utf8"));
    assert.equal(content.slides.length, 1);
    assert.match(content.slides[0].html, /\.\/assets\/logo\.svg/);
    assert.doesNotMatch(content.slides[0].html, /\/decks\//);
    const layout = JSON.parse(fs.readFileSync(path.join(out, "layout.json"), "utf8"));
    const notes = JSON.parse(fs.readFileSync(path.join(out, "notes.json"), "utf8"));
    assert.equal(layout.length, 1);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /Fixture note/);

    // index.html must reference its bundle with relative URLs (static hosting).
    const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
    assert.match(html, /href="\.\/assets\//);
    assert.doesNotMatch(html, /src="\/assets/);

    // The bundled cascade must match the portal's module-graph order: the
    // theme's `.ph p { margin: 0 }` must come AFTER reveal's `.reveal p`
    // margins, or exported slide text gains UA-level block margins.
    const css = fs.readFileSync(path.join(out, "assets", bundledCss), "utf8");
    const revealPIndex = css.indexOf(".reveal p{");
    const phPIndex = css.search(/\.ph h1,\.ph h2,\.ph p,\.ph li\{margin:0/);
    assert.ok(revealPIndex >= 0, "bundled css is missing the reveal p rule");
    assert.ok(phPIndex >= 0, "bundled css is missing the theme .ph p rule");
    assert.ok(phPIndex > revealPIndex, "theme .ph p rule must cascade after .reveal p (renderer css first in the static entry)");
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
});

test("exportCommand fails when required export assets are missing", async () => {
  const out = path.join(tmpProject(), "bad");
  try {
    await assert.rejects(
      exportCommand({ args: { deck: "bad", out }, cwd: fixtureDir }),
      (error) => {
        assert.match(error.message, /missing 1 asset/);
        assert.match(error.message, /missing\.png/);
        return true;
      },
    );
    // No broken export and no transient build workspace may remain.
    assert.equal(fs.existsSync(out), false);
    assert.equal(fs.existsSync(path.join(cliRoot, ".lattice-export")), false);
  } finally {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
