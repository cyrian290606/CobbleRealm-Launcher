/*
 * Test d'interface avec le VRAI Electron (mode développement isolé, aucune installation réelle touchée).
 * Vérifie à plusieurs tailles de fenêtre : pas de chevauchement, pas de texte coupé, pas de défilement parasite.
 * Ne clique jamais sur JOUER.
 *
 *   node test/e2e-ui.js [dossierCaptures]
 */
const { spawn } = require("child_process");
const { startFakeMinecraft } = require("./fake-minecraft");
const { createTestServer } = require("../tools/test-server");
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
  const errBox = document.getElementById('errorBox');
  if (!errBox.hidden) { const e = errBox.getBoundingClientRect(); if (e.right > p.r + 1 || e.bottom > p.b + 1 || e.y < p.y - 1) issues.push('la boîte d erreur déborde du panneau'); }
  const sideBySide = p.r + 16 > c.x && p.x - 16 < c.r;
  if (sideBySide && c.b + 8 > p.y) issues.push('annonce chevauche le panneau JOUER (' + Math.round(c.b) + ' > ' + Math.round(p.y) + ')');
  if (c.x < t.r && c.r > t.x && c.y < t.b + 8) issues.push('annonce chevauche les boutons du haut');
  const clipped = [...document.querySelectorAll('.play-panel *, .update-card *')].filter((e) => e.offsetParent && e.children.length === 0 && e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflow === 'visible' && e.getBoundingClientRect().right > p.r + 1 && p.x < e.getBoundingClientRect().x);
  return { stage: card.dataset.stage || 'complète', issues, card: c && { y: Math.round(c.y), b: Math.round(c.b), h: Math.round(c.h) }, panel: p && { y: Math.round(p.y), b: Math.round(p.b) } };
})()`;

(async () => {
  const mc = await startFakeMinecraft({ version: { name: "1.21.1", protocol: 767 }, players: { max: 100, online: 24 } });
  const web = createTestServer();
  const webBase = await web.listen();
  web.state.blobs.set("/CHANGELOG.md", Buffer.from("## Version 9.9.9 — 1 janvier 2030\n\n### Nouveautés\n- Nouveauté **en ligne** de test.\n\n### Corrections\n- Un bug en ligne corrigé.\n\n## Version 2.0.0\n\n### Nouveautés\n- Ancienne version.\n"));
  web.state.blobs.set("/news.json", Buffer.from(JSON.stringify({ badge: "📣 ANNONCE DE TEST", title: "Annonce", titleHighlight: "serveur local", version: "V77", paragraphs: ["Texte de l'annonce de test."] })));

  const electron = require(path.join(project, "node_modules", "electron"));
  const env = { ...process.env, COBBLEREALM_DEV: "1", COBBLEREALM_ROOT: path.join(tmp, "jeu"), COBBLEREALM_MANIFEST_URL: "http://127.0.0.1:1/manifest.json", ELECTRON_ENABLE_LOGGING: "1",
    COBBLEREALM_SERVER: `127.0.0.1:${mc.port}`, COBBLEREALM_CHANGELOG_URL: `${webBase}/CHANGELOG.md`, COBBLEREALM_NEWS_URL: `${webBase}/news.json` };
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
    ["erreur affichée (4 boutons, message long)", `(() => { document.getElementById("updateBarWrap").hidden = true; showError({ title: "Connexion à Minecraft impossible", message: "Les services Minecraft ont refusé la connexion (code 403). Essaie de te reconnecter avec ton compte, ou demande de laide à léquipe CobbleRealm sur Discord.", code: "MINECRAFT_DENIED", actions: ["switchAccount", "retry", "copy", "help"] }); })()`],
    ["téléchargement en cours", `(() => { document.getElementById('updateBarWrap').hidden = false; document.getElementById('updateBar').style.width = '42%'; document.getElementById('updateDetail').textContent = 'cobblemon-fabric-1.6.1+1.21.1.jar — 38/212 fichiers — 412,3 Mo / 1,92 Go — 18,4 Mo/s'; document.getElementById('launcherUpdateStatus').textContent = 'Téléchargement... 42%'; })()`]
  ];

  for (const [label, setup] of scenarios) {
    await ev(setup); await sleep(200);
    if (label.startsWith("téléchargement")) await ev("hideError()");
    for (const [w, h] of SIZES) {
      await size(w, h); await sleep(150);
      const m = await ev(MEASURE);
      check(`${label} — ${w}×${h}`, m.issues.length === 0, m.issues.length ? m.issues.join(" ; ") : `annonce « ${m.stage} »`);
      if (label === "annonce courte" || (label === "annonce très longue" && w === 900)) await shot(`g1-${label.replace(/ /g, "-")}-${w}x${h}.png`);
      if (label.startsWith("erreur") && [900, 1184, 1920].includes(w)) await shot(`g2-erreur-${w}x${h}.png`);
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

  /* ---- Groupe 3 : compte Microsoft ---- */
  const key = async (k, code, vk) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
    await sleep(150);
  };
  const LONG_EMAIL = "un.pseudo.vraiment.tres.long.pour.tester@adresse-mail-longue.example.com";

  await size(1200, 700);
  await ev("showDisconnected()");
  const colors = {
    offline: await ev("getComputedStyle(document.querySelector('.account-status')).color"),
    hintOffline: await ev("document.getElementById('accountHint').textContent"),
  };
  await ev("showConnectedAccount('joueur@mail.com')");
  colors.online = await ev("getComputedStyle(document.querySelector('.account-status')).color");
  colors.hintOnline = await ev("document.getElementById('accountHint').textContent");
  await ev("showAccountError('Connexion impossible')");
  colors.error = await ev("getComputedStyle(document.querySelector('.account-status')).color");
  check("« Non connecté » est gris (plus vert), « connecté » est vert, l'erreur est rouge",
    colors.offline === "rgb(154, 171, 193)" && colors.online === "rgb(54, 234, 160)" && colors.error === "rgb(255, 143, 152)", JSON.stringify(colors));
  check("indications d'action : « Se connecter » / « Gérer le compte »", colors.hintOffline.startsWith("Se connecter") && colors.hintOnline.startsWith("Gérer"), colors.hintOffline + " | " + colors.hintOnline);

  for (const [w, h] of SIZES) {
    await size(w, h);
    await ev(`showConnectedAccount(${JSON.stringify(LONG_EMAIL)})`);
    await ev("document.getElementById('accountMenu').hidden = false");
    const m = await ev(`(() => {
      const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, r: b.right, b: b.bottom }; };
      const side = r(document.querySelector('.sidebar')), acc = r(document.getElementById('microsoftAccount')), menu = r(document.getElementById('accountMenu'));
      const title = document.querySelector('.account-title'), issues = [];
      if (title.scrollWidth > title.clientWidth + 1) issues.push('titre « Compte Microsoft » coupé');
      if (acc.r > side.r || acc.b > innerHeight) issues.push('carte du compte hors de la barre');
      if (menu.y < 0 || menu.r > side.r + 1 || menu.b > acc.y) issues.push('menu mal placé');
      const items = [...document.querySelectorAll('#accountMenu button')].map(r);
      if (items.some((i) => i.r > menu.r + 1)) issues.push('bouton du menu qui déborde');
      return issues;
    })()`);
    await ev("document.getElementById('accountMenu').hidden = true");
    check(`compte et menu — ${w}×${h}`, m.length === 0, m.join(" ; "));
  }

  /* clavier : Entrée ouvre le menu, flèche bas change d'élément, Échap ferme et rend le focus */
  await size(1200, 700);
  await ev("showConnectedAccount('joueur@mail.com'); document.getElementById('microsoftAccount').focus()");
  await key("Enter", "Enter", 13);
  let k = await ev("({ open: !document.getElementById('accountMenu').hidden, expanded: document.getElementById('microsoftAccount').getAttribute('aria-expanded'), focus: document.activeElement.id })");
  check("clavier : Entrée ouvre le menu et place le focus sur « Changer de compte »", k.open && k.expanded === "true" && k.focus === "accountSwitch", JSON.stringify(k));
  await key("ArrowDown", "ArrowDown", 40);
  check("clavier : flèche bas passe à « Se déconnecter »", (await ev("document.activeElement.id")) === "accountLogout");
  await key("Escape", "Escape", 27);
  k = await ev("({ open: !document.getElementById('accountMenu').hidden, focus: document.activeElement.id })");
  check("clavier : Échap ferme le menu et rend le focus au compte", !k.open && k.focus === "microsoftAccount", JSON.stringify(k));

  /* déconnexion : confirmation en une étape, puis retour à l'état normal sans second clic */
  await ev("document.getElementById('microsoftAccount').click()");
  await ev("document.getElementById('accountLogout').click()");
  const confirm1 = await ev("document.getElementById('accountLogout').textContent.trim()");
  check("déconnexion : premier clic demande une confirmation", confirm1 === "Confirmer la déconnexion", confirm1);
  await sleep(4300);
  check("déconnexion : sans second clic, la confirmation expire", (await ev("document.getElementById('accountLogout').textContent.trim()")) === "Se déconnecter");
  await ev("closeAccountMenu()");

  /* menu indisponible pendant un lancement */
  await ev("minecraftLaunching = true; document.getElementById('microsoftAccount').click()");
  const busy = await ev("({ sw: document.getElementById('accountSwitch').disabled, lo: document.getElementById('accountLogout').disabled, note: document.getElementById('accountMenuNote').textContent })");
  check("pendant un lancement : changer de compte et déconnexion désactivés, avec explication", busy.sw && busy.lo && /pendant le lancement/.test(busy.note), JSON.stringify(busy));
  await ev("minecraftLaunching = false; closeAccountMenu()");

  /* fenêtre du code : durée de validité, boutons, clavier, annulation */
  for (const [w, h] of [[900, 600], [1200, 700], [2560, 1440]]) {
    await size(w, h);
    await ev("showDeviceCode({ userCode: 'AB12CD34', verificationUri: 'https://microsoft.com/devicelogin', expiresIn: 905 })");
    await sleep(200);
    const d = await ev(`(() => {
      const card = document.querySelector('#microsoftModal .modal-card').getBoundingClientRect();
      const btns = [...document.querySelectorAll('#microsoftModal .modal-actions button')].map((b) => b.getBoundingClientRect());
      return { timer: document.getElementById('deviceCodeTimer').textContent, page: document.getElementById('deviceCodePage').textContent,
        focus: document.activeElement.id, fits: card.y >= 0 && card.bottom <= innerHeight && card.right <= innerWidth && btns.every((b) => b.right <= card.right && b.bottom <= card.bottom), n: btns.length };
    })()`);
    check(`fenêtre du code — ${w}×${h} : minuteur, page, 3 boutons dans la fenêtre, focus sur « Copier le code »`,
      /^15:0\d$|^14:5\d$/.test(d.timer) && d.page === "microsoft.com/devicelogin" && d.n === 3 && d.fits && d.focus === "deviceCopy", JSON.stringify(d));
    if (w === 900) await shot("g3-fenetre-code-900x600.png");
    if (w !== 2560) await ev("hideDeviceCode()");
  }
  await key("Tab", "Tab", 9);
  const t1 = await ev("document.activeElement.id");
  await key("Tab", "Tab", 9); await key("Tab", "Tab", 9);
  const t3 = await ev("document.activeElement.id");
  check("clavier : Tab reste dans la fenêtre du code (Copier → Rouvrir → Annuler → Copier)", t1 === "deviceReopen" && t3 === "deviceCopy", t1 + " / " + t3);
  await key("Escape", "Escape", 27);
  await sleep(300);
  check("clavier : Échap annule et ferme la fenêtre du code", !(await ev("document.getElementById('microsoftModal').classList.contains('show')")));

  await size(1200, 700);
  await ev("showConnectedAccount('joueur@mail.com'); document.getElementById('accountMenu').hidden = false");
  await shot("g3-menu-compte-1200x700.png");
  await ev("document.getElementById('accountMenu').hidden = true; showDisconnected()");
  await shot("g3-non-connecte-1200x700.png");

  /* ---- Groupe 4 : zone de téléchargement ---- */
  const STATES = {
    "inactif": "hideError(); document.getElementById('updateBarWrap').hidden = true; document.getElementById('updateWarning').hidden = true",
    "téléchargement": "hideError(); document.getElementById('updateWarning').hidden = true; document.getElementById('updateBarWrap').hidden = false; document.getElementById('progressTitle').textContent = 'Téléchargement... 42 %'; document.getElementById('progressEta').textContent = '≈ 3 min restantes'; document.getElementById('updateBar').style.width = '42%'; document.getElementById('updateDetail').textContent = 'cobblemon-fabric-1.6.1+1.21.1-un-nom-de-fichier-tres-long.jar · 38/212 fichiers · 412,3 Mo / 1,92 Go · 18,4 Mo/s'",
    "avertissement": "hideError(); document.getElementById('updateBarWrap').hidden = true; document.getElementById('updateWarning').textContent = 'Hors-ligne : lancement de la version installée (v10).'; document.getElementById('updateWarning').hidden = false",
    "annulation (information)": "document.getElementById('updateBarWrap').hidden = true; document.getElementById('updateWarning').hidden = true; showError({ title: 'Mise à jour annulée', message: 'Mise à jour annulée. Tu pourras la reprendre quand tu veux : les fichiers déjà téléchargés sont conservés.', code: 'UPDATE_CANCELLED', severity: 'info', actions: ['retry'] })"
  };

  for (const [w, h] of SIZES) {
    await size(w, h);
    const rows = {};
    for (const [name, script] of Object.entries(STATES)) {
      await ev(script); await sleep(120);
      rows[name] = await ev(`(() => { const p = document.querySelector('.play-panel').getBoundingClientRect(), b = document.getElementById('playButton').getBoundingClientRect(), d = document.getElementById('updateDetail'), c = document.getElementById('cancelUpdate');
        return { panelH: Math.round(p.height), btnY: Math.round(b.y), detailClipped: !document.getElementById('updateBarWrap').hidden && d.scrollWidth > d.clientWidth + 1 && getComputedStyle(d).textOverflow !== 'ellipsis', cancelVisible: c.getBoundingClientRect().right <= p.right && c.getBoundingClientRect().bottom <= p.bottom }; })()`);
    }
    const issues = [];
    const buttonYs = new Set(Object.values(rows).map((r) => r.btnY));
    if (buttonYs.size !== 1) issues.push("le bouton JOUER bouge : " + [...buttonYs].join(" / "));
    const busyHeights = new Set(["téléchargement", "avertissement", "annulation (information)"].map((n) => rows[n].panelH));
    if (busyHeights.size !== 1) issues.push("hauteur du panneau instable : " + ["téléchargement", "avertissement", "annulation (information)"].map((n) => n + "=" + rows[n].panelH).join(", "));
    if (rows["téléchargement"].detailClipped || !rows["téléchargement"].cancelVisible) issues.push("détail coupé ou bouton Annuler hors du panneau");
    check(`zone de téléchargement stable — ${w}×${h}`, issues.length === 0, issues.join(" ; ") || "bouton JOUER fixe, hauteur constante");
    if ([900, 1200].includes(w)) { await ev(STATES["téléchargement"]); await shot(`g4-telechargement-${w}x${h}.png`); }
  }
  await ev(STATES["inactif"]);

  /* bannière « nouvelle version du launcher » dans la barre latérale */
  for (const [w, h] of SIZES) {
    await size(w, h);
    await ev("document.getElementById('selfUpdateBox').hidden = false; document.getElementById('selfUpdateText').textContent = 'Nouvelle version du launcher prête (v2.0.1).'; document.getElementById('selfUpdateButton').hidden = false; showConnectedAccount('joueur@mail.com')");
    const m = await ev(`(() => { const r = (id) => document.getElementById(id).getBoundingClientRect(); const side = document.querySelector('.sidebar').getBoundingClientRect(), box = r('selfUpdateBox'), acc = r('microsoftAccount'), menu = document.querySelector('.menu').getBoundingClientRect(), issues = [];
      if (box.right > side.right || box.left < side.left) issues.push('bannière hors de la barre latérale');
      if (box.bottom > acc.top) issues.push('bannière sur le compte');
      if (box.top < menu.bottom) issues.push('bannière sur le menu de navigation');
      const btn = r('selfUpdateButton'); if (btn.right > box.right || btn.bottom > box.bottom + 1) issues.push('bouton Redémarrer déborde');
      return issues; })()`);
    check(`bannière du launcher dans la barre latérale — ${w}×${h}`, m.length === 0, m.join(" ; "));
    if (w === 1200) await shot("g4-banniere-launcher-1200x700.png");
  }
  await ev("document.getElementById('selfUpdateBox').hidden = true");

  /* ---- Groupe 5 : informations fiables ---- */
  await size(1200, 700);
  const waitFor = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await ev(expr); if (v) return v; } catch {} await sleep(200); } return null; };

  const online = await waitFor("(() => { const v = document.getElementById('serverValue').textContent.trim(); return !document.getElementById('serverRow').hidden && v; })()");
  check("serveur : statut réel avec joueurs connectés et places maximales (« 24/100 joueurs »)", online === "EN LIGNE · 24/100 joueurs", String(online));

  mc.response = { version: { name: "1.21.1" } };                        // le serveur masque les joueurs
  await ev("refreshServerStatus()"); await sleep(400);
  check("serveur : joueurs masqués par le serveur -> « EN LIGNE » sans compteur inventé", (await ev("document.getElementById('serverValue').textContent.trim()")) === "EN LIGNE");

  mc.response = { players: { max: 100, online: 0 } };
  await ev("refreshServerStatus()"); await sleep(400);
  check("serveur : 0 joueur affiché « 0/100 »", (await ev("document.getElementById('serverValue').textContent.trim()")) === "EN LIGNE · 0/100 joueurs");

  /* le serveur s'éteint : hors ligne (ou « indisponible » si cette machine n'a pas Internet) */
  await mc.close();
  await ev("refreshServerStatus()"); await sleep(2500);
  const down = await ev("({ text: document.getElementById('serverValue').textContent.trim(), cls: document.getElementById('serverValue').className, dot: document.getElementById('serverDot').className })");
  check("serveur éteint : « HORS LIGNE » (jamais « EN LIGNE »)", down.text !== "" && !/^EN LIGNE/.test(down.text) && /^(HORS LIGNE|STATUT INDISPONIBLE)$/.test(down.text), JSON.stringify(down));
  await shot("g5-serveur-hors-ligne-1200x700.png");

  for (const [w, h] of SIZES) {
    await size(w, h);
    await ev("showServerStatus({ configured: true, state: 'online', players: { online: 124, max: 1000 } })");
    const m = await ev(`(() => { const p = document.querySelector('.play-panel').getBoundingClientRect(), r = document.getElementById('serverRow').getBoundingClientRect(), v = document.getElementById('serverValue'); const issues = [];
      if (r.right > p.right || r.bottom > p.bottom || r.top < p.top) issues.push('ligne serveur hors du panneau');
      if (v.getBoundingClientRect().right > p.right - 8) issues.push('texte du serveur déborde');
      return issues; })()`);
    check(`ligne « Serveur » dans le panneau — ${w}×${h}`, m.length === 0, m.join(" ; "));
  }
  await ev("showServerStatus({ configured: false })");
  check("serveur non configuré : la ligne est masquée (aucune information inventée)", await ev("document.getElementById('serverRow').hidden"));
  await size(1200, 700);

  /* versions réelles */
  const info = await ev("({ sub: document.getElementById('brandSubtitle').textContent.trim(), mc: document.getElementById('chipMinecraft').textContent.trim(), fab: document.getElementById('chipFabric').textContent.trim(), pack: document.getElementById('chipPack').textContent.trim() })");
  const pkgVersion = require("../package.json").version;
  check("versions : launcher dans le sous-titre, Minecraft et Fabric réels, pack sans faux numéro", info.sub === `Launcher officiel · v${pkgVersion}` && /^◇ Minecraft \d/.test(info.mc) && /^⚙ Fabric \d/.test(info.fab) && info.pack === "★ CobbleRealm", JSON.stringify(info));

  /* annonce : la version de l'annonce (V77) ne devient pas le numéro du pack */
  await ev("loadLauncherNews()");        // les scénarios précédents ont remplacé l'annonce par des annonces de test
  const newsOk = await waitFor("document.querySelector('#updateCard .update-badge') && document.querySelector('#updateCard .update-badge').textContent.includes('ANNONCE DE TEST')");
  check("annonce : texte reçu affiché, squelette de chargement remplacé", Boolean(newsOk) && !(await ev("!!document.querySelector('.news-skeleton')")) && (await ev("document.getElementById('updateCard').getAttribute('aria-busy')")) === null);
  check("annonce : le numéro de version de l'annonce n'est pas présenté comme version du pack", !(await ev("document.getElementById('chipPack').textContent.includes('V77')")));

  /* page Changelog : vraies nouveautés (source en ligne), sans texte de remplissage */
  await ev("document.getElementById('changelogButton').click()");
  const cl = await waitFor("document.querySelector('#changelogList h2') && document.querySelector('#changelogList h2').textContent.includes('9.9.9')");
  const page = await ev(`(() => ({ cards: [...document.querySelectorAll('#changelogList .changelog-card')].map(c => c.querySelector('h2').textContent), first: document.querySelector('#changelogList .changelog-card').textContent, items: [...document.querySelectorAll('#changelogList li')].map(l => l.textContent), note: document.getElementById('changelogNote').hidden, text: document.getElementById('changelogView').textContent }))()`);
  check("changelog : versions en ligne affichées dans l'ordre, « Dernière version » sur la première, mise en forme retirée", Boolean(cl) && page.cards[0] === "Version 9.9.9" && page.cards[1] === "Version 2.0.0" && /Dernière version/.test(page.first) && page.items[0] === "Nouveauté en ligne de test." && page.note, JSON.stringify(page.cards));
  check("changelog : plus de texte de remplissage ni d'ancienne version fictive", !/V4\b|Retrouvez ici|nouveautés et correctifs/.test(page.text), "");
  const bigPage = await ev("(() => { const el = document.querySelector('.changelog-page'); return el.scrollHeight >= el.clientHeight && getComputedStyle(el).overflowY === 'auto'; })()");
  check("changelog : la page défile si elle est longue", bigPage);
  await shot("g5-changelog-1200x700.png");
  await size(900, 600); await shot("g5-changelog-900x600.png"); await size(1200, 700);
  await ev("document.getElementById('homeButton').click()");
  await web.close().catch(() => {});

  /* ---- Groupe 6 : bouton JOUER ---- */
  const PLAY_STATES = [
    ["prêt", "setPlayState('JOUER','▶',false)", { busy: false, ellipsisOk: false }],
    ["mise à jour disponible", "setPlayState('METTRE À JOUR ET JOUER','▶',false)", { busy: false, ellipsisOk: false }],
    ["vérification (spinner)", "setPlayState('VÉRIFICATION...','⏳',true)", { busy: true, ellipsisOk: false }],
    ["message d'étape long", "setPlayState('TÉLÉCHARGEMENT DE JAVA 21... 100%','⏳',true)", { busy: true, ellipsisOk: false }],
    ["message démesuré", "setPlayState('PRÉPARATION DE FABRIC 0.18.4 POUR MINECRAFT 1.21.1 ET COBBLEMON...','⏳',true)", { busy: true, ellipsisOk: true }],
    ["en jeu", "setPlayState('EN JEU','✓',true)", { busy: false, ellipsisOk: false }]
  ];
  for (const [w, h] of SIZES) {
    await size(w, h);
    const issues = [];
    for (const [label, script, expect] of PLAY_STATES) {
      await ev(script);
      const r = await ev(`(() => { const b = document.getElementById('playButton'), t = document.getElementById('playText'), i = document.getElementById('playIcon');
        const br = b.getBoundingClientRect(), tr = t.getBoundingClientRect(), ir = i.getBoundingClientRect();
        return { inside: tr.left >= br.left && tr.right <= br.right - 6 && ir.left >= br.left && ir.right <= br.right,
          clipped: t.scrollWidth > t.clientWidth + 1, sw: t.scrollWidth, cw: t.clientWidth, bw: Math.round(br.width), fs: getComputedStyle(b).fontSize, cls: b.className, hourglass: b.textContent.includes('⏳'), spinner: i.classList.contains('play-spinner'),
          anim: getComputedStyle(i).animationName, cursor: getComputedStyle(b).cursor, state: b.dataset.state, busyAttr: b.getAttribute('aria-busy'), disabled: b.disabled }; })()`);
      if (!r.inside) issues.push(label + " : texte hors du bouton");
      if (r.clipped && !expect.ellipsisOk) issues.push(label + " : texte coupé (" + r.sw + "/" + r.cw + " bouton " + r.bw + " police " + r.fs + " " + r.cls + ")");
      if (r.hourglass) issues.push(label + " : sablier emoji");
      if (r.spinner !== expect.busy) issues.push(label + " : spinner " + (expect.busy ? "absent" : "inattendu"));
      if (expect.busy && (r.anim !== "cr-spin" || r.cursor !== "progress" || r.state !== "busy" || r.busyAttr !== "true")) issues.push(label + " : état occupé incomplet " + JSON.stringify(r));
      if (!expect.busy && label === "prêt" && (r.disabled || r.state !== "ready" || r.cursor !== "pointer")) issues.push("prêt : bouton inactif " + JSON.stringify(r));
      if (label === "en jeu" && (r.state !== "done" || r.cursor !== "default")) issues.push("en jeu : état « terminé » incorrect " + JSON.stringify(r));
    }
    check(`bouton JOUER, tous ses états — ${w}×${h}`, issues.length === 0, issues.join(" ; ") || "6 états lisibles et complets");
    if (w === 1200) { await ev(PLAY_STATES[2][1]); await shot("g6-jouer-spinner-1200x700.png"); await ev(PLAY_STATES[1][1]); await shot("g6-jouer-mise-a-jour-1200x700.png"); }
  }
  await ev("setPlayState('JOUER','▶',false)");

  /* ---- Groupe 7 : accessibilité ---- */
  await size(1200, 700);
  await ev("hideDeviceCode(); closeAccountMenu(); document.getElementById('homeButton').click(); showDisconnected(); setPlayState('JOUER','▶',false)");
  await ev("window.__playClicks = 0; document.getElementById('playButton').addEventListener('click', (e) => { window.__playClicks++; e.stopImmediatePropagation(); e.preventDefault(); }, true)");

  const chord = async (modifiers, k, code, vk) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", modifiers, key: k, code, windowsVirtualKeyCode: vk });
    await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key: k, code, windowsVirtualKeyCode: vk });
    await sleep(150);
  };
  const ALT = 1, CTRL = 2;
  const visibleView = () => ev("['homeView','changelogView','consoleView','settingsView'].find((id) => document.getElementById(id).style.display !== 'none')");

  const roles = await ev("({ ok: [...document.querySelectorAll('.menu-item')].every((i) => i.getAttribute('role') === 'button' && i.tabIndex === 0), current: [...document.querySelectorAll('.menu-item[aria-current]')].map((i) => i.id), status: document.getElementById('launcherUpdateStatus').getAttribute('role'), ram: !!document.getElementById('ramSelect').getAttribute('aria-label'), log: document.getElementById('consoleOutput').getAttribute('role') })");
  check("rôles : menu = boutons au clavier, page courante annoncée, statut et journal étiquetés", roles.ok && JSON.stringify(roles.current) === '["homeButton"]' && roles.status === "status" && roles.ram && roles.log === "log", JSON.stringify(roles));

  await chord(ALT, "2", "Digit2", 50);
  const nav2 = [await visibleView(), await ev("document.querySelector('.menu-item[aria-current]').id")];
  await chord(ALT, "3", "Digit3", 51);
  const nav3 = await visibleView();
  await chord(ALT, "4", "Digit4", 52);
  const nav4 = await visibleView();
  await chord(ALT, "1", "Digit1", 49);
  const nav1 = await visibleView();
  check("raccourcis : Alt+2 Changelog, Alt+3 Console, Alt+4 Paramètres, Alt+1 Accueil (et page courante mise à jour)",
    nav2[0] === "changelogView" && nav2[1] === "changelogButton" && nav3 === "consoleView" && nav4 === "settingsView" && nav1 === "homeView", JSON.stringify([nav2, nav3, nav4, nav1]));

  await ev("document.getElementById('consoleButton').focus()");
  await key("Enter", "Enter", 13);
  const viaEnter = await visibleView();
  await ev("document.getElementById('homeButton').focus()");
  await key(" ", "Space", 32);
  check("menu : Entrée et Espace ouvrent la page ciblée", viaEnter === "consoleView" && (await visibleView()) === "homeView", viaEnter);

  await chord(CTRL, "Enter", "Enter", 13);
  const clicks1 = await ev("window.__playClicks");
  await ev("setPlayState('VÉRIFICATION...','⏳',true)");
  await chord(CTRL, "Enter", "Enter", 13);
  const clicks2 = await ev("window.__playClicks");
  await ev("setPlayState('JOUER','▶',false)");
  check("raccourci Ctrl+Entrée : lance le jeu seulement quand le bouton est actif", clicks1 === 1 && clicks2 === 1, clicks1 + " / " + clicks2);

  /* un raccourci ne doit jamais agir derrière une fenêtre ouverte */
  await ev("showDeviceCode({ userCode: 'AB12CD34', verificationUri: 'https://microsoft.com/devicelogin', expiresIn: 900 })");
  await chord(ALT, "2", "Digit2", 50);
  const blocked = await visibleView();
  await chord(CTRL, "Enter", "Enter", 13);
  const clicks3 = await ev("window.__playClicks");
  await key("Escape", "Escape", 27); await sleep(250);
  check("raccourcis ignorés tant qu'une fenêtre est ouverte", blocked === "homeView" && clicks3 === 1, blocked + " / " + clicks3);

  /* parcours complet au clavier : chaque élément atteint est visible ET entouré d'un anneau net */
  await ev("document.activeElement && document.activeElement.blur()");
  /* un clic sur une zone non interactive (le logo) remet le point de départ de Tab au début de la page */
  const brand = await ev("(() => { const r = document.querySelector('.brand-title').getBoundingClientRect(); return { x: r.x + 5, y: r.y + 5 }; })()");
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: brand.x, y: brand.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: brand.x, y: brand.y, button: "left", clickCount: 1 });
  await ev("showConnectedAccount('joueur@mail.com'); loadLauncherNews && renderNews(FALLBACK_NEWS)");
  await size(1366, 768);
  const visited = [];
  for (let i = 0; i < 40; i++) {
    await key("Tab", "Tab", 9);
    const f = await ev(`(() => { const e = document.activeElement; if (!e || e === document.body) return null; const r = e.getBoundingClientRect(), c = getComputedStyle(e);
      return { id: e.id || e.className.toString().slice(0, 30) || e.tagName, w: Math.round(r.width), h: Math.round(r.height), style: c.outlineStyle, width: parseFloat(c.outlineWidth), shadow: c.boxShadow !== 'none' }; })()`);
    if (!f) break;
    visited.push(f);
    if (visited.length > 1 && visited[0].id === f.id) break;
  }
  const ids = visited.map((v) => v.id);
  const want = ["homeButton", "changelogButton", "consoleButton", "settingsButton", "microsoftAccount", "discordButton", "siteButton", "shopButton", "playButton"];
  const missing = want.filter((id) => !ids.includes(id));
  const invisible = visited.filter((v) => v.w === 0 || v.h === 0).map((v) => v.id);
  const noRing = visited.filter((v) => !(v.style !== "none" && v.width >= 2)).map((v) => v.id);
  check("Tab : parcourt menu, compte, Discord, Site, Boutique et JOUER, sans élément caché", missing.length === 0 && invisible.length === 0, "manquants : " + missing.join(",") + " ; cachés : " + invisible.join(",") + " ; ordre : " + ids.join(" > "));
  check("focus visible : chaque élément atteint au clavier a un anneau net (≥ 2 px)", noRing.length === 0, noRing.join(", "));
  const order = ids.indexOf("homeButton") < ids.indexOf("microsoftAccount") && ids.indexOf("microsoftAccount") < ids.indexOf("discordButton") && ids.indexOf("discordButton") < ids.indexOf("playButton");
  check("ordre de tabulation logique : menu, compte, liens du haut, JOUER", order, ids.join(" > "));

  await ev("document.getElementById('playButton').focus()");
  await shot("g7-focus-jouer-1366x768.png");
  await ev("document.getElementById('settingsButton').focus()");
  await shot("g7-focus-menu-1366x768.png");

  /* « Lire la suite » : le focus ne s'échappe pas */
  await size(900, 600);
  await ev("openNewsModal()");
  await key("Tab", "Tab", 9); await key("Tab", "Tab", 9); await key("Tab", "Tab", 9);
  const trapped = await ev("document.activeElement.id");
  await key("Escape", "Escape", 27); await sleep(250);
  check("fenêtre « Lire la suite » : Tab garde le focus dans la fenêtre, Échap la ferme", trapped === "newsModalClose" && !(await ev("document.getElementById('newsModal').classList.contains('show')")), trapped);
  await size(1200, 700);

  /* Aucune erreur dans la page */
  const problems = events.filter((e) => e.method === "Runtime.exceptionThrown" || (e.method === "Log.entryAdded" && e.params.entry.level === "error" && !/Failed to load resource|ERR_CONNECTION/.test(e.params.entry.text)));
  check("aucune erreur CSP / exception dans la page", problems.length === 0, JSON.stringify(problems.slice(0, 2).map((p) => p.params.entry ? p.params.entry.text : p.params.exceptionDetails.text)));

  app.kill(); await sleep(1500);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log(results.every(Boolean) ? "\nTout est OK" : "\nDes vérifications ont échoué");
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error("ERREUR :", e.message); process.exit(2); });
