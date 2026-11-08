/*
 * Test d'interface avec le VRAI Electron (mode développement isolé, aucune installation réelle touchée).
 * Vérifie à plusieurs tailles de fenêtre : pas de chevauchement, pas de texte coupé, pas de défilement parasite.
 * Ne clique jamais sur JOUER.
 *
 *   node test/e2e-ui.js [dossierCaptures]
 */
const { spawn } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os");

const project = path.resolve(__dirname, "..");
const shots = process.argv[2] || null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cr-ui-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomPort = () => 20000 + Math.floor(Math.random() * 20000);
const DEBUG_PORT = randomPort();
const SERVER_PORT = randomPort();
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`  ${ok ? "OK   " : "ECHEC"} ${name}${detail ? " — " + detail : ""}`); };

/* 1184x661 = taille réelle du contenu de la fenêtre par défaut (1200x700 avec cadre Windows) */
const SIZES = [[900, 600], [1000, 650], [1100, 680], [1184, 661], [1200, 700], [1366, 768], [1920, 1080], [2560, 1440]];

const LONG_NEWS = {
  badge: "📣 MISE À JOUR V99", title: "Une très longue", titleHighlight: "annonce de test", version: "V99",
  paragraphs: Array.from({ length: 8 }, (_, i) => [{ text: `Paragraphe ${i + 1} : `, className: "cyan" },
    { text: "texte volontairement long pour vérifier que l'annonce ne recouvre jamais le panneau de lancement, quelle que soit la taille de la fenêtre du joueur.", className: "" }])
};

/* Mesures exécutées dans la page */
const MEASURE = `(() => {
  const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
  const card = document.getElementById('updateCard'), panel = document.querySelector('.play-panel'), side = document.querySelector('.sidebar');
  const title = document.querySelector('.brand-title'), account = document.getElementById('microsoftAccount'), menu = document.querySelector('.menu');
  const top = document.querySelector('.top-actions');
  const c = rect(card), p = rect(panel), t = rect(top);
  const issues = [];
  const vw = innerWidth, vh = innerHeight;
  if (document.documentElement.scrollWidth > vw || document.documentElement.scrollHeight > vh) issues.push('défilement de la page');
  const range = document.createRange(); range.selectNodeContents(title);
  const textRight = range.getBoundingClientRect().right;
  if (textRight > rect(side).r - 12) issues.push('logo coupé ou collé au bord (' + Math.round(textRight) + ' > ' + Math.round(rect(side).r - 12) + ')');
  if (rect(account).b > vh) issues.push('carte compte hors écran');
  if (rect(menu).b > rect(account).y) issues.push('menu chevauche le compte');
  if (c.r > vw || c.b > vh || c.y < 0) issues.push('annonce hors écran');
  if (p.y < 0 || p.b > vh) issues.push('panneau JOUER hors écran');
  const sideBySide = p.r + 16 > c.x && p.x - 16 < c.r;
  if (sideBySide && c.b + 8 > p.y) issues.push('annonce chevauche le panneau JOUER (' + Math.round(c.b) + ' > ' + Math.round(p.y) + ')');
  if (c.x < t.r && c.r > t.x && c.y < t.b + 8) issues.push('annonce chevauche les boutons du haut');
  const clipped = [...document.querySelectorAll('.play-panel *, .update-card *')].filter((e) => e.offsetParent && e.children.length === 0 && e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflow === 'visible' && e.getBoundingClientRect().right > p.r + 1 && p.x < e.getBoundingClientRect().x);
  return { stage: card.dataset.stage || 'complète', issues, card: c && { y: Math.round(c.y), b: Math.round(c.b), h: Math.round(c.h) }, panel: p && { y: Math.round(p.y), b: Math.round(p.b) } };
})()`;

(async () => {
  const electron = require(path.join(project, "node_modules", "electron"));
  const env = { ...process.env, COBBLEREALM_DEV: "1", COBBLEREALM_ROOT: path.join(tmp, "jeu"), COBBLEREALM_MANIFEST_URL: "http://127.0.0.1:1/manifest.json", ELECTRON_ENABLE_LOGGING: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(electron, [".", `--remote-debugging-port=${DEBUG_PORT}`, "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion", `--user-data-dir=${path.join(tmp, "ud")}`], { cwd: project, env });
  let out = ""; app.stdout.on("data", (d) => out += d); app.stderr.on("data", (d) => out += d);

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()).find((t) => t.type === "page" && t.url.includes("index.html")); } catch {}
    if (!target) await sleep(500);
  }
  if (!target) throw new Error("fenêtre introuvable\n" + out.slice(-800));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pending = new Map(); const events = [];
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else events.push(m); });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result.result.value; };
  const size = async (w, h) => { await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }); await ev("window.dispatchEvent(new Event('resize'))"); await sleep(250); };
  const shot = async (name) => { if (!shots) return; const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(shots, name), Buffer.from(r.result.data, "base64")); };
  await send("Runtime.enable"); await send("Log.enable");

  for (let i = 0; i < 60; i++) {
    try { if (await ev("!!(document.getElementById('updateCard') && document.getElementById('updateCard').firstChild)")) break; } catch { /* page pas encore chargée */ }
    await sleep(250);
  }
  await sleep(500);

  const scenarios = [
    ["annonce courte", "void 0"],
    ["annonce très longue", `renderNews(${JSON.stringify(LONG_NEWS)})`],
    ["téléchargement en cours", `(() => { document.getElementById('updateBarWrap').hidden = false; document.getElementById('updateBar').style.width = '42%'; document.getElementById('updateDetail').textContent = 'cobblemon-fabric-1.6.1+1.21.1.jar — 38/212 fichiers — 412,3 Mo / 1,92 Go — 18,4 Mo/s'; document.getElementById('launcherUpdateStatus').textContent = 'Téléchargement... 42%'; })()`]
  ];

  for (const [label, setup] of scenarios) {
    await ev(setup); await sleep(200);
    for (const [w, h] of SIZES) {
      await size(w, h); await sleep(150);
      const m = await ev(MEASURE);
      check(`${label} — ${w}×${h}`, m.issues.length === 0, m.issues.length ? m.issues.join(" ; ") : `annonce « ${m.stage} »`);
      if (label === "annonce courte" || (label === "annonce très longue" && w === 900)) await shot(`g1-${label.replace(/ /g, "-")}-${w}x${h}.png`);
    }
  }

  /* « Lire la suite » à la plus petite taille, avec l'annonce longue */
  await ev(`renderNews(${JSON.stringify(LONG_NEWS)})`);
  await ev("document.getElementById('updateBarWrap').hidden = true");
  await size(900, 600); await sleep(250);
  const stage = await ev("document.getElementById('updateCard').dataset.stage");
  check("annonce longue à 900×600 : version réduite avec bouton « Lire la suite »", ["compact", "mini", "pill"].includes(stage), stage);
  await ev("(document.querySelector('.news-more') && getComputedStyle(document.querySelector('.news-more')).display !== 'none' ? document.querySelector('.news-more') : document.querySelector('.news-pill')).click()");
  await sleep(250);
  const modal = await ev("({ open: document.getElementById('newsModal').classList.contains('show'), paragraphs: document.querySelectorAll('#newsModalBody .update-text').length, focus: document.activeElement.id, fits: (() => { const b = document.querySelector('.news-modal-card').getBoundingClientRect(); return b.y >= 0 && b.bottom <= innerHeight && b.right <= innerWidth; })() })");
  check("fenêtre « Lire la suite » : texte complet (8 paragraphes), bouton Fermer actif, entre dans la fenêtre", modal.open && modal.paragraphs === 8 && modal.focus === "newsModalClose" && modal.fits, JSON.stringify(modal));
  await shot("g1-lire-la-suite-900x600.png");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(250);
  check("Échap ferme la fenêtre", !(await ev("document.getElementById('newsModal').classList.contains('show')")));

  /* Aucune erreur dans la page */
  const problems = events.filter((e) => e.method === "Runtime.exceptionThrown" || (e.method === "Log.entryAdded" && e.params.entry.level === "error" && !/Failed to load resource|ERR_CONNECTION/.test(e.params.entry.text)));
  check("aucune erreur CSP / exception dans la page", problems.length === 0, JSON.stringify(problems.slice(0, 2).map((p) => p.params.entry ? p.params.entry.text : p.params.exceptionDetails.text)));

  app.kill(); await sleep(1500);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log(results.every(Boolean) ? "\nTout est OK" : "\nDes vérifications ont échoué");
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error("ERREUR :", e.message); process.exit(2); });
