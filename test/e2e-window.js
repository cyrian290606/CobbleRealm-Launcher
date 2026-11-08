/*
 * Test avec le VRAI Electron : la taille de la fenêtre est mémorisée et retrouvée au lancement suivant,
 * et un fichier abîmé ou une position hors écran ne bloque rien. Mode développement isolé, ne clique jamais sur JOUER.
 *
 *   node test/e2e-window.js
 */
const { spawn } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os");

const project = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cr-win-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`  ${ok ? "OK   " : "ECHEC"} ${name}${detail ? " — " + detail : ""}`); };
const stateFile = path.join(tmp, "ud", "window-state.json");

async function session(run) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const electron = require(path.join(project, "node_modules", "electron"));
  const env = { ...process.env, COBBLEREALM_DEV: "1", COBBLEREALM_ROOT: path.join(tmp, "jeu"), COBBLEREALM_MANIFEST_URL: "http://127.0.0.1:1/manifest.json" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(electron, [".", `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(tmp, "ud")}`], { cwd: project, env });
  const exited = new Promise((r) => app.on("exit", r));

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page" && t.url.includes("index.html")); } catch {}
    if (!target) await sleep(500);
  }
  if (!target) { app.kill(); throw new Error("fenêtre introuvable"); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pending = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); return r.result.result.value; };
  await sleep(1500);

  const closeWindow = async () => {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const bws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((r) => bws.addEventListener("open", r));
    bws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    await Promise.race([exited, sleep(8000)]);
    try { app.kill(); } catch {}
  };

  try { return await run({ ev, closeWindow }); } finally { try { app.kill(); } catch {} }
}

const near = (a, b) => Math.abs(a - b) <= 2;
const outer = (ev) => ev("({ w: outerWidth, h: outerHeight, x: screenX, y: screenY })");

(async () => {
  /* 1) premier lancement : taille par défaut, puis le joueur redimensionne */
  await session(async ({ ev, closeWindow }) => {
    const first = await outer(ev);
    check("premier lancement : taille par défaut 1200×700", near(first.w, 1200) && near(first.h, 700), JSON.stringify(first));
    await ev("window.cobbleRealm.devResizeWindow(1000, 640)");
    await sleep(1200);
    check("la taille est enregistrée dès le redimensionnement", fs.existsSync(stateFile), stateFile);
    await closeWindow();
  });

  const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  check("fichier enregistré valide (taille ≥ 900×600, pas maximisée)", saved.width >= 900 && saved.height >= 600 && saved.maximized === false, JSON.stringify(saved));

  /* 2) relance : la même taille revient */
  await session(async ({ ev, closeWindow }) => {
    const again = await outer(ev);
    check("relance : taille et position retrouvées", near(again.w, saved.width) && near(again.h, saved.height) && near(again.x, saved.x) && near(again.y, saved.y), `${JSON.stringify(again)} / attendu ${JSON.stringify(saved)}`);
    await closeWindow();
  });

  /* 3) position hors de tous les écrans : la fenêtre est recentrée, visible */
  fs.writeFileSync(stateFile, JSON.stringify({ x: 25000, y: 25000, width: 1100, height: 700, maximized: false }));
  await session(async ({ ev, closeWindow }) => {
    const r = await outer(ev);
    check("position hors écran : fenêtre ramenée à l'écran, taille gardée", near(r.w, 1100) && near(r.h, 700) && r.x < 5000 && r.y < 5000, JSON.stringify(r));
    await closeWindow();
  });

  /* 4) fichier abîmé : démarrage normal à la taille par défaut */
  fs.writeFileSync(stateFile, "{pas du json");
  await session(async ({ ev, closeWindow }) => {
    const r = await outer(ev);
    check("fichier abîmé : démarrage normal", near(r.w, 1200) && near(r.h, 700), JSON.stringify(r));
    await closeWindow();
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter((ok) => !ok).length;
  console.log(failed ? `\n${failed} vérification(s) en échec` : "\nTout est correct");
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
