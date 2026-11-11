import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { nextTabIndex } from "../src/lib/keyboard-nav.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appVue = path.join(root, "src", "App.vue");
const flclashDir = path.join(root, "src", "components", "flclash");

function read(rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

describe("flclash-ui nav shell", () => {
  it("keeps only flash/monitor/about pages and does not restore station/workbench", () => {
    const src = readFileSync(appVue, "utf8");
    assert.match(src, /id: "flash"/);
    assert.match(src, /id: "monitor"/);
    assert.match(src, /id: "about"/);
    assert.doesNotMatch(src, /\bstation_/);
    assert.doesNotMatch(src, /工作台/);
    assert.match(src, /section-panel-flash/);
    assert.match(src, /section-panel-monitor/);
    assert.match(src, /section-panel-about/);
  });

  it("owns flclash shell components and layout css", () => {
    for (const name of [
      "NavCapsule.vue",
      "ThemeQuickToggle.vue",
      "AppearancePicker.vue",
      "flclash-layout.css",
      "useAppearanceOptional.ts",
    ]) {
      assert.equal(existsSync(path.join(flclashDir, name)), true, name);
    }
  });

  it("wires capsule nav + theme entry without forging appearance.ts", () => {
    const src = readFileSync(appVue, "utf8");
    assert.match(src, /NavCapsule/);
    assert.match(src, /ThemeQuickToggle/);
    assert.match(src, /AppearancePicker/);
    assert.match(src, /flclash-layout\.css/);
    assert.doesNotMatch(src, /from ["']@\/lib\/appearance/);
    const optional = read("src/components/flclash/useAppearanceOptional.ts");
    assert.match(optional, /import\.meta\.glob/);
    assert.match(optional, /appearance\.ts/);
  });

  it("uses unique primary tab ids strategy for narrow/wide", () => {
    const nav = read("src/components/flclash/NavCapsule.vue");
    assert.match(nav, /section-tab-\$\{id\}/);
    assert.match(nav, /section-tab-\$\{props\.variant\}-\$\{id\}/);
    assert.match(nav, /:inert=/);
    const src = readFileSync(appVue, "utf8");
    assert.match(src, /:primary="!narrowLayout"/);
    assert.match(src, /:primary="narrowLayout"/);
  });

  it("page transition and nav motion tokens are declared in layout css", () => {
    const css = read("src/components/flclash/flclash-layout.css");
    assert.match(css, /--fl-nav-motion:\s*var\(--ws-motion-nav/);
    assert.match(css, /--fl-page-motion:\s*var\(--ws-motion-page/);
    assert.match(css, /translateY\(6px\)/);
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /-webkit-tap-highlight-color:\s*transparent/);
  });

  it("keyboard nextTabIndex still supports arrows/home/end for 3 tabs", () => {
    assert.equal(nextTabIndex(0, "ArrowRight", 3), 1);
    assert.equal(nextTabIndex(2, "ArrowRight", 3), 0);
    assert.equal(nextTabIndex(0, "ArrowLeft", 3), 2);
    assert.equal(nextTabIndex(1, "Home", 3), 0);
    assert.equal(nextTabIndex(1, "End", 3), 2);
    assert.equal(nextTabIndex(1, "Enter", 3), null);
  });
});
