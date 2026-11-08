/*
 * Tests du module updater/ (phase 3). Lancer avec : node test/updater.test.js
 * Serveur HTTP local + dossiers temporaires : ni réseau, ni installation réelle touchés.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const { createUpdater } = require("../updater");
const { validateManifest } = require("../updater/manifest");
const { createTestServer } = require("../tools/test-server");

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const blob = (label, size = 3000) => Buffer.from(label.repeat(Math.ceil(size / label.length)).slice(0, size));
const exists = (p) => fs.existsSync(p);
const read = (p) => fs.readFileSync(p, "utf8");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const POLICY = { "options.txt": "default", "servers.dat": "default", "config/xaero/x.txt": "default" };

/* Environnement : serveur + dossier de jeu + fabrique de manifests */
async function setup() {

    const srv = createTestServer();
    const base = await srv.listen();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-upd-"));
    const events = [];

    const env = {
        srv, base, root, events,

        publish(files, version) {
            const manifest = {
                schema: 2, version, minecraft: "1.21.1", fabricLoader: "0.18.4", java: 21, recommendedRamGb: 6,
                strictDirs: ["mods"], preserved: ["saves/**"], files: []
            };
            for (const [p, content] of Object.entries(files)) {
                const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
                const hash = sha(buf);
                srv.state.blobs.set(`/f/${hash}`, buf);
                manifest.files.push({
                    path: p, size: buf.length, sha256: hash, url: `${base}/f/${hash}`, policy: POLICY[p] || "managed"
                });
            }
            srv.state.manifest = manifest;
            return manifest;
        },

        updater(options = {}) {
            return createUpdater({
                gameRoot: root, manifestUrl: `${base}/manifest.json`, allowLocal: true,
                onProgress: (e) => events.push(e),
                fetchOptions: { retryDelayMs: 1 },
                downloadOptions: { retryDelayMs: 1 },
                ...options
            });
        },

        fileRequests: () => srv.state.requests.filter((r) => r.path.startsWith("/f/")),
        manifestRequests: () => srv.state.requests.filter((r) => r.path === "/manifest.json"),
        resetRequests: () => { srv.state.requests.length = 0; },
        cleanup: async () => { await srv.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }
    };

    return env;
}

const V1 = () => ({
    "mods/a.jar": blob("A1"), "mods/b.jar": blob("B1"),
    "config/main.json": "{\"v\":1}", "options.txt": "fov:70", "resourcepacks/pack.zip": blob("PACK")
});

async function withEnv(fn) {
    const env = await setup();
    try { await fn(env); } finally { await env.cleanup(); }
}

/* ---------------- installation neuve ---------------- */

test("Première installation propre", () => withEnv(async (env) => {
    env.publish(V1(), "1.0.0");
    const r = await env.updater().sync();
    assert.ok(r.ok && !r.offline);
    assert.strictEqual(r.downloaded, 5);
    assert.strictEqual(read(path.join(env.root, "config/main.json")), "{\"v\":1}");
    assert.strictEqual(read(path.join(env.root, "options.txt")), "fov:70");
    assert.ok(!exists(env.srv && path.join(env.root, ".staging")), "staging nettoyé");

    const lock = JSON.parse(read(path.join(env.root, "lock.json")));
    assert.strictEqual(lock.version, "1.0.0");
    assert.strictEqual(Object.keys(lock.files).length, 5);
    assert.ok(env.events.some((e) => e.step === "plan" && /5 fichiers à télécharger/.test(e.message)));
    assert.ok(env.events.some((e) => e.step === "download" && e.percent === 100));

    // 2e passage : rien à faire, aucun téléchargement
    env.resetRequests();
    const again = await env.updater().sync();
    assert.strictEqual(again.downloaded, 0);
    assert.strictEqual(env.fileRequests().length, 0);
}));

/* ---------------- migration ---------------- */

test("Migration d'une installation existante sans lock.json (aucun retéléchargement inutile)", () => withEnv(async (env) => {
    const m = env.publish(V1(), "1.0.0");
    const w = (rel, content) => { const f = path.join(env.root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };

    // installation « ancienne » : fichiers conformes, sauf 1 modifié et 1 manquant
    w("mods/a.jar", blob("A1"));                 // conforme
    w("mods/b.jar", blob("B1"));                 // conforme
    w("config/main.json", "{\"v\":0-modifié}");  // différent -> à retélécharger
    // resourcepacks/pack.zip manquant           // à télécharger
    w("options.txt", "fov:110-du-joueur");      // default : jamais écrasé
    w("version.json", "{\"version\":\"10\"}");
    w("saves/monde/level.dat", "SAUVEGARDE");
    w("screenshots/a.png", "png");
    w("config/personnel.json", "perso");         // inconnu : jamais supprimé
    w("mods/parasite.jar", "parasite");          // mode strict : mis en quarantaine
    w("mods/perso.jar.disabled", "x");           // pas un .jar : intact

    const r = await env.updater().sync();
    assert.ok(r.ok);
    assert.strictEqual(env.fileRequests().length, 2, "seulement le fichier modifié et le manquant");
    assert.strictEqual(read(path.join(env.root, "config/main.json")), "{\"v\":1}");
    assert.ok(exists(path.join(env.root, "resourcepacks/pack.zip")));
    assert.strictEqual(read(path.join(env.root, "options.txt")), "fov:110-du-joueur");
    assert.strictEqual(read(path.join(env.root, "saves/monde/level.dat")), "SAUVEGARDE");
    assert.strictEqual(read(path.join(env.root, "version.json")), "{\"version\":\"10\"}");
    assert.strictEqual(read(path.join(env.root, "config/personnel.json")), "perso");
    assert.ok(exists(path.join(env.root, "mods/perso.jar.disabled")));
    assert.ok(!exists(path.join(env.root, "mods/parasite.jar")), "parasite retiré de mods/");
    const removed = fs.readdirSync(path.join(env.root, ".removed"));
    assert.ok(exists(path.join(env.root, ".removed", removed[0], "mods", "parasite.jar")), "récupérable dans .removed/");
    assert.strictEqual(Object.keys(JSON.parse(read(path.join(env.root, "lock.json"))).files).length, 4);
    assert.strictEqual(m.files.length, 5);
}));

/* ---------------- mise à jour ---------------- */

test("Mise à jour : mod ajouté, modifié, retiré, config modifiée ; options du joueur intactes", () => withEnv(async (env) => {
    env.publish(V1(), "1.0.0");
    await env.updater().sync();

    fs.writeFileSync(path.join(env.root, "options.txt"), "fov:110-du-joueur");
    env.resetRequests();

    env.publish({
        "mods/a.jar": blob("A2"),                    // modifié
        "mods/c.jar": blob("C1"),                    // ajouté
        // mods/b.jar retiré
        "config/main.json": "{\"v\":2}",             // config managed modifiée
        "options.txt": "fov:70-nouveau-defaut",      // default : ne doit pas écraser
        "resourcepacks/pack.zip": blob("PACK")       // inchangé
    }, "1.1.0");

    const updater = env.updater();
    const info = await updater.check();
    assert.ok(info.updateAvailable);
    assert.strictEqual(info.filesToDownload, 3);

    const r = await updater.sync();
    assert.strictEqual(r.downloaded, 3);
    assert.strictEqual(env.fileRequests().length, 3, "seuls les 3 fichiers changés sont téléchargés");
    assert.strictEqual(env.manifestRequests().length, 1, "manifest lu une seule fois (check + sync)");

    assert.strictEqual(read(path.join(env.root, "mods/a.jar")), blob("A2").toString());
    assert.ok(exists(path.join(env.root, "mods/c.jar")));
    assert.ok(!exists(path.join(env.root, "mods/b.jar")));
    const dir = fs.readdirSync(path.join(env.root, ".removed"))[0];
    assert.ok(exists(path.join(env.root, ".removed", dir, "mods/b.jar")), "mod retiré mis en quarantaine");
    assert.strictEqual(read(path.join(env.root, "config/main.json")), "{\"v\":2}");
    assert.strictEqual(read(path.join(env.root, "options.txt")), "fov:110-du-joueur");
    assert.strictEqual(JSON.parse(read(path.join(env.root, "lock.json"))).version, "1.1.0");
}));

test("Retour à une ancienne version du manifest", () => withEnv(async (env) => {
    env.publish(V1(), "1.0.0");
    await env.updater().sync();
    env.publish({ "mods/a.jar": blob("A2"), "mods/c.jar": blob("C1"), "config/main.json": "{\"v\":2}" }, "2.0.0");
    await env.updater().sync();

    env.publish(V1(), "1.0.0");                      // retour en arrière
    const r = await env.updater().sync();
    assert.ok(r.ok);
    assert.strictEqual(read(path.join(env.root, "mods/a.jar")), blob("A1").toString());
    assert.ok(exists(path.join(env.root, "mods/b.jar")));
    assert.ok(!exists(path.join(env.root, "mods/c.jar")));
    assert.strictEqual(read(path.join(env.root, "config/main.json")), "{\"v\":1}");
    assert.strictEqual(JSON.parse(read(path.join(env.root, "lock.json"))).version, "1.0.0");
}));

test("Deux chemins au contenu identique : un seul téléchargement", () => withEnv(async (env) => {
    env.publish({ "mods/a.jar": blob("A1"), "mods/copie.jar": blob("A1") }, "1.0.0");
    const r = await env.updater().sync();
    assert.strictEqual(env.fileRequests().length, 1);
    assert.ok(exists(path.join(env.root, "mods/a.jar")) && exists(path.join(env.root, "mods/copie.jar")));
    assert.ok(r.ok);
}));

/* ---------------- réseau : coupure et reprise ---------------- */

test("Coupure réseau en plein téléchargement : reprise avec Range, contenu correct", () => withEnv(async (env) => {
    const big = blob("GROS", 600000);
    env.publish({ "mods/gros.jar": big, "mods/a.jar": blob("A1") }, "1.0.0");
    env.srv.state.faults.cutAfter[`/f/${sha(big)}`] = 200000;

    const r = await env.updater().sync();
    assert.ok(r.ok);
    assert.ok(read(path.join(env.root, "mods/gros.jar")) === big.toString());
    const ranges = env.fileRequests().filter((q) => q.range).map((q) => q.range);
    assert.ok(ranges.some((x) => /^bytes=\d{5,}-$/.test(x)), `reprise attendue, requêtes : ${JSON.stringify(ranges)}`);
}));

test("Serveur qui ignore Range : le fichier est quand même téléchargé en entier", () => withEnv(async (env) => {
    const big = blob("GROS", 400000);
    env.publish({ "mods/gros.jar": big }, "1.0.0");
    env.srv.state.faults.cutAfter[`/f/${sha(big)}`] = 100000;
    env.srv.state.faults.ignoreRange = true;
    const r = await env.updater().sync();
    assert.ok(r.ok);
    assert.strictEqual(read(path.join(env.root, "mods/gros.jar")), big.toString());
}));

test("Échec puis reprise lors d'une 2e exécution : les fichiers déjà vérifiés ne sont pas retéléchargés", () => withEnv(async (env) => {
    const a = blob("A1"), b = blob("B1");
    env.publish({ "mods/a.jar": a, "mods/b.jar": b }, "1.0.0");
    await env.updater().sync();                       // installation valide de base

    const a2 = blob("A2"), b2 = blob("B2");
    env.publish({ "mods/a.jar": a2, "mods/b.jar": b2 }, "1.1.0");
    env.srv.state.faults.fail[`/f/${sha(b2)}`] = Infinity;      // b2 indisponible
    env.resetRequests();

    await assert.rejects(env.updater({ downloadOptions: { retryDelayMs: 1, concurrency: 1 } }).sync(), (e) => e.code === "SERVER");
    assert.strictEqual(read(path.join(env.root, "mods/a.jar")), a.toString(), "jeu inchangé tant que la MAJ n'est pas complète");
    assert.ok(JSON.parse(read(path.join(env.root, "lock.json"))).version === "1.0.0", "ancien lock valide conservé");

    env.srv.state.faults.fail = {};
    env.resetRequests();
    const r = await env.updater().sync();
    assert.ok(r.ok);
    assert.ok(!env.fileRequests().some((q) => q.path === `/f/${sha(a2)}`), "a2 déjà vérifié : pas retéléchargé");
    assert.strictEqual(read(path.join(env.root, "mods/b.jar")), b2.toString());
}));

test("Fichier corrompu côté serveur : refusé après 3 essais, rien d'installé", () => withEnv(async (env) => {
    const a = blob("A1", 5000);
    env.publish({ "mods/a.jar": a }, "1.0.0");
    env.srv.state.faults.corrupt.add(`/f/${sha(a)}`);
    await assert.rejects(env.updater().sync(), (e) => e.code === "CORRUPT" && e.canRepair && /3 essais/.test(e.message));
    assert.ok(!exists(path.join(env.root, "mods/a.jar")));
    assert.ok(!exists(path.join(env.root, "lock.json")));
    assert.strictEqual(env.fileRequests().length, 3);
}));

test("Fichier introuvable (404) : message clair, pas de réessai inutile", () => withEnv(async (env) => {
    env.publish({ "mods/a.jar": blob("A1") }, "1.0.0");
    env.srv.state.blobs.clear();
    await assert.rejects(env.updater().sync(), (e) => e.code === "MISSING_REMOTE" && /introuvable/.test(e.message));
    assert.strictEqual(env.fileRequests().length, 1);
}));

/* ---------------- réparation ---------------- */

test("Réparation : fichier manquant, taille modifiée, contenu altéré à taille identique", () => withEnv(async (env) => {
    env.publish(V1(), "1.0.0");
    await env.updater().sync();

    const a = path.join(env.root, "mods/a.jar");
    const main = path.join(env.root, "config/main.json");
    const pack = path.join(env.root, "resourcepacks/pack.zip");

    fs.rmSync(pack);                                                         // manquant
    fs.writeFileSync(main, "{\"v\":1,\"triche\":true}");                     // taille différente
    const original = fs.readFileSync(a);
    const before = fs.statSync(a);
    const altered = Buffer.from(original); altered[10] ^= 0xff;
    fs.writeFileSync(a, altered);                                            // même taille, contenu différent
    fs.utimesSync(a, before.atime, before.mtime);                            // ... et même date : invisible sans rehash
    assert.strictEqual(Math.floor(fs.statSync(a).mtimeMs), Math.floor(before.mtimeMs), "préparation du test");

    env.resetRequests();
    const normal = await env.updater().sync();
    assert.ok(normal.ok);
    assert.ok(exists(pack));
    assert.strictEqual(read(main), "{\"v\":1}");
    assert.ok(!fs.readFileSync(a).equals(original), "la vérification rapide ne voit pas ce cas (c'est le rôle de la réparation)");

    const repaired = await env.updater().repair();
    assert.ok(repaired.ok);
    assert.ok(fs.readFileSync(a).equals(original), "contenu altéré détecté et restauré par la réparation");
}));

/* ---------------- crash ---------------- */

test("Crash pendant l'application : installation non valide, puis reprise complète sans retéléchargement", () => withEnv(async (env) => {
    // installation valide en 1.0.0 ...
    env.publish(V1(), "1.0.0");
    await env.updater().sync();
    assert.strictEqual(env.updater().status().valid, true);

    // ... puis une mise à jour qui plante au milieu de l'application
    env.publish({ ...V1(), "mods/a.jar": blob("A2"), "mods/b.jar": blob("B2"), "config/main.json": "{\"v\":2}" }, "1.1.0");
    await env.updater({ hooks: { afterFile: (n) => { if (n === 2) throw new Error("crash simulé"); } } }).sync().then(
        () => assert.fail("devait échouer"), () => {});

    const updater = env.updater();
    assert.strictEqual(updater.status().valid, false, "pas de lock.json valide après un crash");
    assert.ok(!exists(path.join(env.root, "lock.json")));
    assert.ok(exists(path.join(env.root, "lock.prev.json")), "l'ancien lock sert d'indice");

    env.resetRequests();
    const r = await env.updater().sync();
    assert.ok(r.ok);
    assert.strictEqual(env.fileRequests().length, 0, "tout était déjà téléchargé ou en place");
    assert.strictEqual(env.updater().status().valid, true);
    assert.strictEqual(JSON.parse(read(path.join(env.root, "lock.json"))).version, "1.1.0");
    assert.strictEqual(read(path.join(env.root, "config/main.json")), "{\"v\":2}");
    assert.ok(!exists(path.join(env.root, "lock.prev.json")));
}));

/* ---------------- disque, sécurité ---------------- */

test("Disque plein : refus avant tout téléchargement, message clair", () => withEnv(async (env) => {
    env.publish(V1(), "1.0.0");
    await assert.rejects(env.updater({ downloadOptions: { freeSpace: () => 0 } }).sync(),
        (e) => e.code === "DISK_FULL" && /espace disque/.test(e.message));
    assert.strictEqual(env.fileRequests().length, 0);
}));

test("Manifest hostile : chemins sortants, URL hors liste blanche, doublons", () => {
    const good = { schema: 2, version: "1", minecraft: "1.21.1", fabricLoader: "0.18.4", java: 21, recommendedRamGb: 6,
        files: [{ path: "mods/a.jar", size: 1, sha256: "a".repeat(64), url: "https://github.com/x/y/releases/download/t/f", policy: "managed" }] };
    assert.doesNotThrow(() => validateManifest(good));

    const clone = (mut) => { const m = JSON.parse(JSON.stringify(good)); mut(m); return m; };
    const bad = [
        clone((m) => { m.files[0].path = "../evasion.jar"; }),
        clone((m) => { m.files[0].path = "C:/Windows/x.dll"; }),
        clone((m) => { m.files[0].path = "mods\\a.jar"; }),
        clone((m) => { m.files[0].url = "https://evil.example.com/a.jar"; }),
        clone((m) => { m.files[0].url = "http://github.com/a.jar"; }),
        clone((m) => { m.files[0].url = "https://github.com.evil.com/a.jar"; }),
        clone((m) => { m.files[0].url = "https://user:pass@github.com/a.jar"; }),
        clone((m) => { m.files.push({ ...m.files[0], path: "MODS/A.JAR" }); }),
        clone((m) => { m.files[0].sha256 = "xx"; }),
        clone((m) => { m.files[0].policy = "preserved"; }),
        clone((m) => { m.schema = 1; })
    ];
    for (const m of bad) assert.throws(() => validateManifest(m), (e) => e.code === "MANIFEST_INVALID");
    assert.doesNotThrow(() => validateManifest(clone((m) => { m.files[0].url = "https://release-assets.githubusercontent.com/x"; })));
});

test("Manifest hostile servi : rien n'est écrit hors du dossier de jeu", () => withEnv(async (env) => {
    env.publish({ "mods/a.jar": blob("A1") }, "1.0.0");
    env.srv.state.manifest.files[0].path = "../../evasion.jar";
    await assert.rejects(env.updater().sync(), (e) => e.code === "MANIFEST_INVALID");
    assert.ok(!exists(path.join(env.root, "..", "evasion.jar")));
    assert.strictEqual(env.fileRequests().length, 0);
}));

test("Redirection vers un domaine non autorisé : refusée", () => withEnv(async (env) => {
    const a = blob("A1");
    env.publish({ "mods/a.jar": a }, "1.0.0");
    env.srv.state.faults.redirect[`/f/${sha(a)}`] = "https://evil.example.com/a.jar";
    await assert.rejects(env.updater().sync(), (e) => e.code === "FORBIDDEN_HOST");
    assert.ok(!exists(path.join(env.root, "mods/a.jar")));
}));

/* ---------------- hors-ligne, quarantaine, garde-fous ---------------- */

test("Hors-ligne : jouable si installation valide, sinon erreur claire", () => withEnv(async (env) => {
    env.publish(V1(), "1.0.0");
    await env.updater().sync();
    await env.srv.close();

    const offline = await env.updater().sync();
    assert.ok(offline.ok && offline.offline, JSON.stringify(offline));
    assert.strictEqual(offline.version, "1.0.0");

    const check = await env.updater().check();
    assert.ok(check.offline && check.valid && check.installedVersion === "1.0.0");

    fs.rmSync(path.join(env.root, "lock.json"));
    await assert.rejects(env.updater().sync(), (e) => e.code === "OFFLINE" && /Internet/.test(e.message));
}));

test("Quarantaine : purge après 30 jours, uniquement dans .removed/", () => withEnv(async (env) => {
    env.publish(V1(), "1.0.0");
    await env.updater().sync();

    const old = path.join(env.root, ".removed", "2020-01-01T00-00-00-000Z");
    const recent = path.join(env.root, ".removed", "recent");
    fs.mkdirSync(path.join(old, "mods"), { recursive: true });
    fs.writeFileSync(path.join(old, "mods/vieux.jar"), "x");
    fs.mkdirSync(recent, { recursive: true });
    const past = new Date(Date.now() - 40 * 86400000);
    fs.utimesSync(old, past, past);
    fs.writeFileSync(path.join(env.root, "saves.txt"), "intact");

    await env.updater().sync();
    assert.ok(!exists(old), "sauvegarde de 40 jours purgée");
    assert.ok(exists(recent), "sauvegarde récente conservée");
    assert.strictEqual(read(path.join(env.root, "saves.txt")), "intact");
}));

test("Garde-fou strict : un manifest sans aucun mod ne vide pas mods/", () => withEnv(async (env) => {
    const m = env.publish({ "config/main.json": "{}" }, "1.0.0");
    assert.deepStrictEqual(m.strictDirs, ["mods"]);
    fs.mkdirSync(path.join(env.root, "mods"), { recursive: true });
    fs.writeFileSync(path.join(env.root, "mods/precieux.jar"), "x");
    await env.updater().sync();
    assert.ok(exists(path.join(env.root, "mods/precieux.jar")));
}));

test("Fichier 'default' absent : copié ; présent : jamais écrasé", () => withEnv(async (env) => {
    env.publish({ "mods/a.jar": blob("A1"), "servers.dat": "serveur-par-defaut", "options.txt": "defaut" }, "1.0.0");
    fs.writeFileSync(path.join(env.root, "options.txt"), "joueur");
    await env.updater().sync();
    assert.strictEqual(read(path.join(env.root, "servers.dat")), "serveur-par-defaut");
    assert.strictEqual(read(path.join(env.root, "options.txt")), "joueur");
}));

/* ---------------- exécution ---------------- */

(async () => {
    let failed = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`  OK    ${name}`); }
        catch (error) {
            failed++;
            console.log(`  ECHEC ${name}\n        ${String(error && error.stack || error).split("\n").slice(0, 4).join("\n        ")}`);
        }
    }
    console.log(failed ? `\n${failed} test(s) en échec` : "\nTous les tests passent");
    process.exit(failed ? 1 : 0);
})();
