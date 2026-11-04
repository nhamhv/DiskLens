// Screenshots of the real UI with made-up data (see mock.js). Start the dev server first:
//   npx vite --port 1420        then        node scripts/screenshots/capture.mjs
// Output: docs/screenshots/*.jpg, copied to site/screenshots/ for the website. Set CHROME=/path/to/chrome if Chrome isn't at the default place.
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const URL = process.env.URL ?? "http://localhost:1420";
const outs = ["../../docs/screenshots", "../../site/screenshots"].map((d) => join(import.meta.dirname, d));
const mock = readFileSync(join(import.meta.dirname, "mock.js"), "utf8");
outs.forEach((d) => mkdirSync(d, { recursive: true }));

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome" });

async function shot(name, run, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, locale: "en-US", colorScheme: "dark" });
  await ctx.addInitScript(`window.__MOCK_OPTS__ = ${JSON.stringify(opts)};`);
  await ctx.addInitScript(mock);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`[${name}]`, e.message));
  await page.goto(URL);
  await page.getByText("DiskLens", { exact: true }).first().waitFor({ state: "attached" });
  await page.waitForTimeout(600);
  await page.addStyleTag({ content: "[data-sonner-toaster]{display:none!important}" });
  await run(page);
  await page.waitForTimeout(500);
  const img = await page.screenshot({ type: "jpeg", quality: 90 });
  outs.forEach((d) => writeFileSync(join(d, `${name}.jpg`), img));
  console.log("saved", name);
  await ctx.close();
}

const openHome = async (p) => {
  await p.getByRole("button", { name: "Home", exact: true }).click();
  await p.locator("[data-treemap], svg, canvas, .treemap").first().waitFor().catch(() => {});
  await p.waitForTimeout(1200);
};
const tab = (p, i) => p.getByRole("tab").nth(i).click();

await shot("welcome", async () => {});
await shot("disk", openHome);
await shot("disk-library", async (p) => {
  await openHome(p);
  await p.getByText("Library", { exact: true }).first().dblclick().catch(() => {});
  await p.waitForTimeout(800);
});
await shot("cleanup", async (p) => {
  await openHome(p);
  await tab(p, 3);
  await p.waitForTimeout(800);
  await p.getByText("Select all", { exact: false }).first().click();
});
await shot("largest", async (p) => { await openHome(p); await tab(p, 1); await p.waitForTimeout(800); });
await shot("changes", async (p) => { await openHome(p); await tab(p, 2); await p.waitForTimeout(800); });
await shot("developer", async (p) => {
  await p.getByRole("button", { name: "Developer" }).click();
  await p.waitForTimeout(1200);
  await p.getByText("mobile-app", { exact: true }).first().click();
  await p.getByRole("button", { name: "Select stale projects" }).click();
});
await shot("photos", async (p) => {
  await p.getByRole("button", { name: "Photos" }).click();
  await p.locator("main button, button:not(header button)").filter({ hasText: /^Scan$/ }).last().click();
  await p.waitForTimeout(1500);
  await p.getByRole("button", { name: /Blurry/ }).click();
  await p.waitForTimeout(1200);
  await p.getByRole("button", { name: "Select all", exact: true }).click();
});
await shot("apps", async (p) => { await p.getByRole("button", { name: "Applications" }).click(); await p.waitForTimeout(2000); });
await shot("report", async (p) => { await p.getByRole("button", { name: "Report a problem" }).click(); await p.waitForTimeout(600); });
await shot("consent", async () => {}, { consent: null });

await browser.close();
