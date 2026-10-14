// `npm start`: like `npm run tauri dev`, but picks a free port when 1420 is taken
// (e.g. another checkout or worktree is already running). Vite and the Tauri window
// must agree on the port, so both are told explicitly instead of letting Vite drift.
import { spawn } from "node:child_process";
import net from "node:net";

const FIRST = Number(process.env.PORT) || 1420;

/** A port is busy if anything accepts a connection on it, over IPv4 or IPv6. */
const busy = (port, host) =>
  new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
    s.setTimeout(300, () => (s.destroy(), resolve(false)));
  });

let port = FIRST;
while ((await busy(port, "127.0.0.1")) || (await busy(port, "::1"))) {
  if (++port > FIRST + 50) throw new Error(`No free port in ${FIRST}-${port}`);
}
if (port !== FIRST) console.log(`Port ${FIRST} is in use — using ${port}`);

const config = JSON.stringify({ build: { devUrl: `http://localhost:${port}` } });
const child = spawn("npx", ["tauri", "dev", "--config", config, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, PORT: String(port) }, // read by vite.config.ts via beforeDevCommand
});
child.on("exit", (code) => process.exit(code ?? 0));
