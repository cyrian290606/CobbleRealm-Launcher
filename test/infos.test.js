/*
 * Tests des informations affichées : statut du serveur (vrai protocole Minecraft) et changelog.
 * Lancer avec : node test/infos.test.js. Aucun réseau réel.
 */

const assert = require("assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const { getServerStatus, parseServerAddress } = require("../serverStatus");
const { parseChangelog, loadLocal, loadOnline, plain } = require("../changelog");
const { createTestServer } = require("../tools/test-server");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const { startFakeMinecraft } = require("./fake-minecraft");

const noInternetCheck = async () => true;
const options = { internetCheck: noInternetCheck, resolveSrv: async () => { throw new Error("pas de SRV"); }, timeoutMs: 1500 };

/* ---------------- statut du serveur ---------------- */

test("Adresse du serveur : formats acceptés et refusés", () => {
    assert.deepStrictEqual(parseServerAddress("play.exemple.fr"), { host: "play.exemple.fr", port: 25565, explicitPort: false });
    assert.deepStrictEqual(parseServerAddress("play.exemple.fr:25570"), { host: "play.exemple.fr", port: 25570, explicitPort: true });
    assert.deepStrictEqual(parseServerAddress(" 127.0.0.1:1234 "), { host: "127.0.0.1", port: 1234, explicitPort: true });
    for (const bad of [null, undefined, "", "a b", "exemple.fr:99999", "exemple.fr:0", "http://exemple.fr", "ex@mple.fr", "a".repeat(300), "exemple.fr:12:34"]) {
        assert.strictEqual(parseServerAddress(bad), null, String(bad));
    }
});

test("Serveur en ligne : nombre de joueurs et places maximales (« 24/100 »)", async () => {
    const mc = await startFakeMinecraft({ version: { name: "1.21.1", protocol: 767 }, players: { max: 100, online: 24 }, description: "CobbleRealm" });
    try {
        const status = await getServerStatus(`127.0.0.1:${mc.port}`, options);
        assert.deepStrictEqual(status, { state: "online", players: { online: 24, max: 100 } });
        assert.deepStrictEqual(mc.seen, { handshakes: 1, statusRequests: 1 });
    } finally { await mc.close(); }
});

test("Serveur en ligne qui masque les joueurs : « en ligne » sans compteur inventé", async () => {
    for (const json of [{ version: { name: "x" } }, { players: { online: "beaucoup", max: 10 } }, { players: { online: -1, max: 10 } }, { players: null }]) {
        const mc = await startFakeMinecraft(json);
        try {
            assert.deepStrictEqual(await getServerStatus(`127.0.0.1:${mc.port}`, options), { state: "online", players: null }, JSON.stringify(json));
        } finally { await mc.close(); }
    }
});

test("0 joueur : affiché comme 0/N (pas masqué)", async () => {
    const mc = await startFakeMinecraft({ players: { max: 50, online: 0 } });
    try {
        assert.deepStrictEqual((await getServerStatus(`127.0.0.1:${mc.port}`, options)).players, { online: 0, max: 50 });
    } finally { await mc.close(); }
});

test("Serveur éteint (le joueur a Internet) : hors ligne", async () => {
    const mc = await startFakeMinecraft({});
    const port = mc.port;
    await mc.close();
    assert.deepStrictEqual(await getServerStatus(`127.0.0.1:${port}`, options), { state: "offline" });
});

test("Le joueur n'a pas Internet : statut inconnu, jamais « hors ligne » à tort", async () => {
    const mc = await startFakeMinecraft({});
    const port = mc.port;
    await mc.close();
    const status = await getServerStatus(`127.0.0.1:${port}`, { ...options, internetCheck: async () => false });
    assert.deepStrictEqual(status, { state: "unknown" });
});

test("Réponses invalides ou serveur qui coupe : jamais « en ligne »", async () => {
    for (const behavior of [{ closeEarly: true }, { garbage: true }]) {
        const mc = await startFakeMinecraft({}, behavior);
        try {
            const status = await getServerStatus(`127.0.0.1:${mc.port}`, options);
            assert.strictEqual(status.state, "offline", JSON.stringify(behavior));
        } finally { await mc.close(); }
    }
});

test("Serveur qui ne répond pas du tout : délai respecté", async () => {
    const silent = net.createServer(() => {});
    await new Promise((r) => silent.listen(0, "127.0.0.1", r));
    try {
        const started = Date.now();
        const status = await getServerStatus(`127.0.0.1:${silent.address().port}`, { ...options, timeoutMs: 300 });
        assert.strictEqual(status.state, "offline");
        assert.ok(Date.now() - started < 2000);
    } finally { silent.close(); silent.closeAllConnections?.(); }
});

test("Enregistrement SRV : un nom de domaine sans port utilise le bon port", async () => {
    const mc = await startFakeMinecraft({ players: { max: 20, online: 3 } });
    try {
        const status = await getServerStatus("play.exemple.fr", { ...options, resolveSrv: async (name) => {
            assert.strictEqual(name, "_minecraft._tcp.play.exemple.fr");
            return [{ name: "127.0.0.1", port: mc.port, priority: 10, weight: 5 }];
        } });
        assert.deepStrictEqual(status, { state: "online", players: { online: 3, max: 20 } });
    } finally { await mc.close(); }
});

test("Adresse invalide ou absente : inconnu", async () => {
    assert.deepStrictEqual(await getServerStatus("n'importe quoi", options), { state: "unknown" });
    assert.deepStrictEqual(await getServerStatus(null, options), { state: "unknown" });
});

/* ---------------- changelog ---------------- */

const SAMPLE = `# Titre ignoré

Texte d'introduction ignoré.

## Version 2.1.0 — 12 novembre 2026

### Nouveautés
- Une **nouvelle** fonction avec un [lien](https://exemple.fr) et du \`code\`.
- <b>Balise</b> retirée

### Améliorations
- Plus rapide.

### Corrections
- Un bug corrigé.

### Section inconnue
- ignorée

## Version 2.0.0

### Nouveautés
- Première version.

## Version 1.9.0

### Nouveautés
`;

test("Lecture du changelog : versions, rubriques, éléments ; mise en forme et HTML retirés", () => {
    const versions = parseChangelog(SAMPLE);
    assert.deepStrictEqual(versions.map((v) => v.version), ["2.1.0", "2.0.0"], "la version vide est ignorée");
    assert.strictEqual(versions[0].date, "12 novembre 2026");
    assert.deepStrictEqual(versions[0].sections.map((s) => s.title), ["Nouveautés", "Améliorations", "Corrections"], "rubrique inconnue ignorée");
    assert.deepStrictEqual(versions[0].sections[0].items, ["Une nouvelle fonction avec un lien et du code.", "Balise retirée"]);
    assert.ok(!JSON.stringify(versions).includes("<b>") && !JSON.stringify(versions).includes("**"));
});

test("Changelog hostile : limites de taille, aucun HTML conservé", () => {
    const huge = "## Version 1.0.0\n### Nouveautés\n" + Array.from({ length: 500 }, (_, i) => `- ${"x".repeat(1000)} ${i}`).join("\n");
    const [v] = parseChangelog(huge);
    assert.strictEqual(v.sections[0].items.length, 60);
    assert.ok(v.sections[0].items.every((t) => t.length <= 300));
    assert.strictEqual(plain("<script>alert(1)</script>Bonjour <img src=x onerror=alert(1)>"), "alert(1)Bonjour");
    assert.deepStrictEqual(parseChangelog("n'importe quoi"), []);
    assert.deepStrictEqual(parseChangelog(""), []);
});

test("Le vrai CHANGELOG.md du projet est lisible et destiné aux joueurs (aucun terme technique)", () => {
    const text = fs.readFileSync(path.join(__dirname, "..", "CHANGELOG.md"), "utf8");
    const versions = parseChangelog(text);
    assert.ok(versions.length >= 1 && versions[0].version === require("../package.json").version, "la première version = version du launcher");
    const forbidden = /\.js\b|\.json\b|IPC|sha-?256|manifest|sandbox|CSP|Electron|MSAL|token|jeton|API\b|function|\bcode source\b|node_modules|main\.js|preload/i;
    for (const v of versions) for (const s of v.sections) for (const item of s.items) {
        assert.ok(!forbidden.test(item), `terme technique dans le changelog public : « ${item} »`);
    }
});

/* ---------------- sources du changelog ---------------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cr-chlog-"));
const embeddedPath = path.join(tmp, "CHANGELOG.md");
fs.writeFileSync(embeddedPath, "## Version 2.0.0\n\n### Nouveautés\n- Version intégrée.\n");

test("Sans réseau ni cache : version intégrée au launcher", () => {
    const r = loadLocal({ embeddedPath, cachePath: path.join(tmp, "absent.json") });
    assert.strictEqual(r.source, "embedded");
    assert.strictEqual(r.versions[0].sections[0].items[0], "Version intégrée.");
});

test("Source en ligne : utilisée, puis gardée en cache ; si elle disparaît, la dernière version connue", async () => {
    const srv = createTestServer();
    const base = await srv.listen();
    const cachePath = path.join(tmp, "cache1.json");
    try {
        srv.state.blobs.set("/CHANGELOG.md", Buffer.from("## Version 2.1.0\n\n### Corrections\n- Version en ligne.\n"));

        const online = await loadOnline({ url: `${base}/CHANGELOG.md`, cachePath, allowLocal: true });
        assert.strictEqual(online.source, "online");
        assert.strictEqual(online.versions[0].version, "2.1.0");

        // la source disparaît : on garde la dernière version connue (cache), pas l'intégrée
        srv.state.blobs.delete("/CHANGELOG.md");
        assert.strictEqual(await loadOnline({ url: `${base}/CHANGELOG.md`, cachePath, allowLocal: true }), null);
        const local = loadLocal({ embeddedPath, cachePath });
        assert.strictEqual(local.source, "cache");
        assert.strictEqual(local.versions[0].sections[0].items[0], "Version en ligne.");
    } finally { await srv.close(); }
});

test("Source en ligne invalide, vide ou trop grosse : ignorée, le joueur garde l'existant", async () => {
    const srv = createTestServer();
    const base = await srv.listen();
    const cachePath = path.join(tmp, "cache2.json");
    try {
        for (const body of ["<html>erreur 500</html>", "", "x".repeat(300 * 1024)]) {
            srv.state.blobs.set("/CHANGELOG.md", Buffer.from(body));
            assert.strictEqual(await loadOnline({ url: `${base}/CHANGELOG.md`, cachePath, allowLocal: true }), null);
        }
        assert.ok(!fs.existsSync(cachePath), "rien n'est mis en cache");
        assert.strictEqual(loadLocal({ embeddedPath, cachePath }).source, "embedded");
    } finally { await srv.close(); }
});

test("Source en ligne : seule la liste de domaines GitHub est autorisée (jamais une adresse quelconque)", async () => {
    const { MANIFEST_HOSTS } = require("../updater/manifest");
    const { checkUrl } = require("../updater/http");

    // la couche réseau reçoit exactement la liste blanche du projet
    let received = null;
    await loadOnline({ url: "https://raw.githubusercontent.com/cyrian290606/CobbleRealm-Launcher/main/CHANGELOG.md", cachePath: path.join(tmp, "cache3.json"),
        requestFn: async (url, opts) => { received = opts; throw new Error("réseau coupé"); } });
    assert.deepStrictEqual(received.allowedHosts, MANIFEST_HOSTS);
    assert.ok(!received.allowLocal, "pas d'adresse locale en production");

    // et cette liste refuse tout le reste
    for (const bad of ["https://evil.example.com/CHANGELOG.md", "http://raw.githubusercontent.com/x", "https://github.com.evil.com/x", "https://user:pw@github.com/x"]) {
        assert.throws(() => checkUrl(bad, { allowedHosts: received.allowedHosts }), (e) => e.code === "FORBIDDEN_HOST", bad);
    }
    assert.doesNotThrow(() => checkUrl("https://raw.githubusercontent.com/cyrian290606/CobbleRealm-Launcher/main/CHANGELOG.md", { allowedHosts: received.allowedHosts }));
});

/* ---------------- exécution ---------------- */

(async () => {
    let failed = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`  OK    ${name}`); }
        catch (error) { failed++; console.log(`  ECHEC ${name}\n        ${String(error.stack || error).split("\n").slice(0, 3).join("\n        ")}`); }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failed ? `\n${failed} test(s) en échec` : "\nTous les tests passent");
    process.exit(failed ? 1 : 0);
})();
