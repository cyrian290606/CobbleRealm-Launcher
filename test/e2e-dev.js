/*
 * Test de bout en bout avec le VRAI Electron, en mode développement isolé (dossier de jeu, APPDATA
 * et serveur de mise à jour jetables). Pilotage via le protocole de débogage (ports aléatoires, jamais ceux d'un autre test en cours).
 * N'appelle jamais launchMinecraft avec une mise à jour réussie : aucune connexion Microsoft.
 *
 *   node test/e2e-dev.js [dossierProjet] [dossierCaptures]
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");

const project = process.argv[2] || path.resolve(__dirname, "..");
const shots = process.argv[3];     // dossier optionnel pour les captures d'écran
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cr-e2e-"));
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomPort = () => 20000 + Math.floor(Math.random() * 20000);
const DEBUG_PORT = randomPort();
const SERVER_PORT = randomPort();
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); log(`  ${ok ? "OK   " : "ECHEC"} ${name}${detail ? " — " + detail : ""}`); };

(async () => {
  /* 1. modpack de démonstration + publication réelle avec publish.js */
  const src = path.join(tmp, "source");
  const w = (rel, buf) => { const f = path.join(src, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); };
  for (const m of ["alpha", "beta", "gamma"]) w(`mods/${m}.jar`, crypto.randomBytes(1_500_000));
  w("config/cobblemon/main.json", '{"a":1}');
  w("options.txt", "fov:70");
  w("saves/monde/level.dat", "NE-DOIT-PAS-ETRE-PUBLIE");
  const out = path.join(tmp, "publish-out");
  const pub = spawnSync(process.execPath, [path.join(project, "tools", "publish.js"), src, "--version", "1.0.0", "--out", out],
    { env: { ...process.env, PUBLISH_REPO_ROOT: path.join(tmp, "depot") }, encoding: "utf8" });
  check("publish.js prépare la publication", pub.status === 0, (pub.stdout.match(/Version .*/) || [pub.stderr])[0]);

  /* 2. serveur de test (débit limité pour voir la progression) */
  const server = spawn(process.execPath, [path.join(project, "tools", "test-server.js"), out, "--port", String(SERVER_PORT), "--speed", "1500"], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve) => server.stdout.on("data", (d) => String(d).includes("Serveur de test") && resolve()));

  /* 3. Electron en mode développement isolé */
  const game = path.join(tmp, "jeu"), appdata = path.join(tmp, "Roaming");
  fs.mkdirSync(appdata, { recursive: true });
  const electron = require(path.join(project, "node_modules", "electron"));
  const env = { ...process.env, APPDATA: appdata, COBBLEREALM_DEV: "1", COBBLEREALM_ROOT: game,
    COBBLEREALM_MANIFEST_URL: `http://127.0.0.1:${SERVER_PORT}/manifest.json`, ELECTRON_ENABLE_LOGGING: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  /* --user-data-dir isole les réglages et la session Microsoft ; COBBLEREALM_ROOT isole le dossier de jeu.
     (APPDATA seul ne suffit PAS sous Windows : Electron lit le vrai dossier Roaming via l'API système.) */
  const app = spawn(electron, [".", `--remote-debugging-port=${DEBUG_PORT}`, "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion", `--user-data-dir=${path.join(tmp, "userdata")}`], { cwd: project, env });
  let appOut = ""; app.stdout.on("data", (d) => appOut += d); app.stderr.on("data", (d) => appOut += d);

  /* 4. protocole de débogage */
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()).find((t) => t.type === "page" && t.url.includes("index.html")); } catch {}
    if (!target) await sleep(500);
  }
  if (!target) throw new Error("fenêtre introuvable\n" + appOut.slice(-1500));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pending = new Map(); const events = [];
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else events.push(m); });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result.result.value; };
  const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); if (shots) fs.writeFileSync(path.join(shots, name), Buffer.from(r.result.data, "base64")); };
  await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
  const waitFor = async (expr, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await ev(expr); if (v) return v; await sleep(250); } return null; };
  const text = (idSel) => `document.getElementById('${idSel}').textContent.trim()`;

  /* 5. démarrage : vérification en lecture seule, rien n'est installé */
  const status = await waitFor(`(${text("launcherUpdateStatus")}).startsWith('Mise à jour disponible') && ${text("launcherUpdateStatus")}`);
  check("statut au démarrage = mise à jour disponible avec fichiers et taille", /^Mise à jour disponible — v1\.0\.0 \(5 fichiers, \d+ Mo\)$/.test(status || ""), status);
  await waitFor("!document.getElementById('playButton').disabled", 10000);
  check("JOUER activé", await ev("!document.getElementById('playButton').disabled && document.getElementById('playText').textContent.trim() === 'JOUER'"));
  check("rien n'est installé avant le clic", !fs.existsSync(path.join(game, "lock.json")) && !fs.existsSync(path.join(game, "mods")));
  const options = await ev("[...document.getElementById('ramSelect').options].map(o => o.value).join(',')");
  check("sélecteur de RAM construit selon la machine", /^2,3,4/.test(options), options);
  await shot("1-demarrage.png");

  /* 6. réparation = synchronisation complète, avec progression visible */
  const repairPromise = ev("window.cobbleRealm.repairInstallation()");
  const sawBar = await waitFor("!document.getElementById('updateBarWrap').hidden", 20000);
  const detail = await ev(text("updateDetail"));
  check("barre de progression + vitesse affichées", Boolean(sawBar) && /fichiers — .*(Ko|Mo) \/ .*(Ko|Mo)/.test(detail), detail);
  await shot("2-telechargement.png");
  const repaired = await repairPromise;
  check("réparation réussie", repaired && repaired.success === true, JSON.stringify(repaired));
  check("fichiers installés", ["mods/alpha.jar", "mods/beta.jar", "mods/gamma.jar", "config/cobblemon/main.json", "options.txt"].every((f) => fs.existsSync(path.join(game, f))));
  check("sauvegardes non publiées", !fs.existsSync(path.join(game, "saves")));
  const lock = JSON.parse(fs.readFileSync(path.join(game, "lock.json"), "utf8"));
  check("lock.json écrit (v1.0.0, 5 fichiers)", lock.version === "1.0.0" && Object.keys(lock.files).length === 5);
  check("staging nettoyé", !fs.existsSync(path.join(game, ".staging")));
  const after = await waitFor(`(${text("launcherUpdateStatus")}).startsWith('CobbleRealm à jour') && ${text("launcherUpdateStatus")}`, 10000);
  check("statut après installation", after === "CobbleRealm à jour — v1.0.0", after);
  check("barre masquée", await ev("document.getElementById('updateBarWrap').hidden"));
  await shot("3-a-jour.png");

  /* 7. panne réseau pendant une mise à jour : le jeu ne doit PAS démarrer */
  fs.rmSync(path.join(game, "mods", "alpha.jar"));
  server.kill(); await sleep(500);
  const launch = await ev("window.cobbleRealm.launchMinecraft({ ram: 4 })");
  check("lancement refusé quand la mise à jour échoue", launch && launch.success === false && launch.step === "update", JSON.stringify(launch).slice(0, 160));
  const errVisible = await waitFor("!document.getElementById('updateErrorBox').hidden", 10000);
  const errText = await ev(text("updateErrorText"));
  check("message d'erreur lisible en français + bouton Réessayer", Boolean(errVisible) && /Internet/.test(errText) && await ev("!document.getElementById('retryButton').offsetParent === false"), errText);
  check("aucune connexion Microsoft tentée", !/microsoft-device-code/.test(JSON.stringify(events)) );
  await shot("4-erreur.png");

  /* 8. console de la page : aucune erreur (CSP, exceptions) */
  const problems = events.filter((e) => (e.method === "Runtime.exceptionThrown") ||
    (e.method === "Log.entryAdded" && ["error", "warning"].includes(e.params.entry.level)) ||
    false);
  check("aucune erreur CSP / exception dans la page", problems.length === 0, JSON.stringify(problems.map((p) => p.params.entry ? p.params.entry.text : (p.params.args || []).map((a) => a.value)).slice(0, 3)));
  check("aucun jeton ni accès refusé dans les logs", !/Appel IPC refusé/.test(appOut));

  app.kill(); server.kill(); await sleep(1500);
  fs.rmSync(tmp, { recursive: true, force: true });
  log(results.every(Boolean) ? "\nTout est OK" : "\nDes vérifications ont échoué");
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error("ERREUR E2E :", e.message); process.exit(2); });
