// Verifies every locale has the same keys as en.json (plural suffixes like _one/_other are folded,
// since languages such as vi/zh/ja only need _other). Exits non-zero on mismatch.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "../src/i18n/locales");
const flatten = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([k, v]) =>
    typeof v === "object" ? flatten(v, `${prefix}${k}.`) : [`${prefix}${k}`.replace(/_(zero|one|two|few|many|other)$/, "")],
  );
const keysOf = (file) => new Set(flatten(JSON.parse(readFileSync(join(dir, file), "utf8"))));

const base = keysOf("en.json");
let failed = false;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "en.json")) {
  const keys = keysOf(file);
  const missing = [...base].filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !base.has(k));
  if (missing.length || extra.length) {
    failed = true;
    console.error(`${file}:`);
    missing.forEach((k) => console.error(`  missing  ${k}`));
    extra.forEach((k) => console.error(`  unknown  ${k}`));
  }
}
if (failed) process.exit(1);
console.log(`Locales OK (${base.size} keys)`);
