/*
 * Tests des bundles (regroupement des petits fichiers) : format, regroupement stable, publication, et installation /
 * mise à jour / réparation / reprise / corruption de bout en bout avec un serveur local.
 * Lancer avec : node test/bundles.test.js   (aucun réseau, dossiers temporaires)
 */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const publish = require("../tools/publish.js");
const { planBundles } = require("../tools/bundling.js");
const { buildBundle, parseBundle, MAGIC } = require("../updater/bundle.js");
const { createUpdater } = require("../updater");
const { createTestServer } = require("../tools/test-server");

const policy = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "tools", "policy.json"), "utf8"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cr-bundles-"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const SMALL_OPTIONS = { targetBytes: 3000, minGroupBytes: 500, maxDepth: 2 };       // de petits bundles pour de petits tests

/* ---------------- format ---------------- */

const entry = (text) => ({ sha256: sha(Buffer.from(text)), data: Buffer.from(text) });

test("Format : un bundle se relit à l'identique, il est déterministe et indépendant de l'ordre", () => {
    const entries = ["a", "bb", "", "dddd"].map(entry);
    const bundle = buildBundle(entries);
    assert.ok(bundle.subarray(0, 4).equals(MAGIC));

    const parsed = parseBundle(bundle);
    assert.strictEqual(parsed.size, 4);
    for (const e of entries) {
        const p = parsed.get(e.sha256);
        assert.deepStrictEqual(bundle.subarray(p.offset, p.offset + p.size), e.data);
    }
    assert.ok(buildBundle([...entries].reverse()).equals(bundle), "même contenu = mêmes octets");
});

test("Format : un bundle abîmé ou hostile est refusé (jamais d'accès hors du fichier)", () => {
    const good = buildBundle(["a", "bb"].map(entry));
    const header = (obj) => { const h = Buffer.from(JSON.stringify(obj)); const l = Buffer.alloc(4); l.writeUInt32BE(h.length); return Buffer.concat([MAGIC, l, h]); };
    const hex = (c) => c.repeat(64);

    for (const bad of [
        Buffer.alloc(0), Buffer.from("XXXX0000"), good.subarray(0, 6), good.subarray(0, good.length - 1).subarray(0, 12),
        Buffer.concat([MAGIC, Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.alloc(10)]),             // index géant
        header({ v: 2, entries: [] }), header({ v: 1 }), header({ v: 1, entries: "x" }),
        Buffer.concat([header({ v: 1, entries: [{ sha256: hex("a"), size: 5, offset: 0 }] })]),       // dépasse les données
        Buffer.concat([header({ v: 1, entries: [{ sha256: hex("a"), size: 1, offset: -1 }] }), Buffer.alloc(4)]),
        Buffer.concat([header({ v: 1, entries: [{ sha256: "zz", size: 1, offset: 0 }] }), Buffer.alloc(4)]),
        Buffer.concat([header({ v: 1, entries: [{ sha256: hex("a"), size: 1, offset: 0 }, { sha256: hex("a"), size: 1, offset: 1 }] }), Buffer.alloc(4)]),
        Buffer.concat([header({ v: 1, entries: [{ sha256: hex("a"), size: 2 ** 60, offset: 0 }] }), Buffer.alloc(4)])
    ]) {
        assert.throws(() => parseBundle(bad), /bundle/, bad.subarray(0, 24).toString("hex"));
    }
});

/* ---------------- regroupement ---------------- */

const content = (p, text) => ({ sha256: sha(Buffer.from(text)), size: text.length, paths: [p] });
const manyFiles = (n, dir = "config/mod", size = 400) => Array.from({ length: n }, (_, i) => content(`${dir}/f${i}.json`, `${dir}-${i}-`.padEnd(size, "x")));

test("Regroupement : chaque contenu dans exactement un bundle ; résultat indépendant de l'ordre", () => {
    const all = [...manyFiles(40, "config/a"), ...manyFiles(25, "config/b"), ...manyFiles(3, "datapacks/x"), content("racine.txt", "r")];
    const plan = planBundles(all, SMALL_OPTIONS);
    const seen = plan.flatMap((b) => b.shas);
    assert.strictEqual(seen.length, all.length);
    assert.strictEqual(new Set(seen).size, all.length);
    assert.ok(plan.every((b) => b.bytes <= 3000 * 1.8), "aucun bundle démesuré");

    const shuffled = [...all].sort(() => 0.5 - Math.random());
    assert.deepStrictEqual(planBundles(shuffled, SMALL_OPTIONS), plan);
});

test("Regroupement : un fichier modifié garde son bundle (1 seul bundle change) ; un fichier ajouté en touche 1", () => {
    const base = manyFiles(55, "config/a");
    const before = planBundles(base, SMALL_OPTIONS);
    const idOf = (plan) => new Map(plan.map((b) => [sha(Buffer.from(b.shas.join())), b]));

    const modified = base.map((c, i) => (i === 7 ? content(c.paths[0], "NOUVEAU CONTENU" + "y".repeat(380)) : c));
    const after = planBundles(modified, SMALL_OPTIONS);
    const a = idOf(before), b = idOf(after);
    assert.strictEqual(before.length, after.length, "même nombre de bundles");
    assert.strictEqual([...b.keys()].filter((k) => !a.has(k)).length, 1, "un seul bundle modifié");

    const added = [...base, content("config/a/nouveau.json", "ajout".padEnd(400, "z"))];
    assert.strictEqual([...idOf(planBundles(added, SMALL_OPTIONS)).keys()].filter((k) => !a.has(k)).length, 1, "un seul bundle touché par un ajout");

    const removed = base.filter((_, i) => i !== 3);
    assert.strictEqual([...idOf(planBundles(removed, SMALL_OPTIONS)).keys()].filter((k) => !a.has(k)).length, 1, "un seul bundle touché par une suppression");
});

test("Regroupement : le nombre de bundles d'un dossier est une puissance de 2 (stable tant que le dossier ne double pas)", () => {
    for (const n of [5, 10, 20, 33, 60, 120]) {
        const plan = planBundles(manyFiles(n, "config/a"), SMALL_OPTIONS);
        const buckets = plan[0].buckets;
        assert.strictEqual(buckets & (buckets - 1), 0, `${n} fichiers : ${buckets} lots`);
    }
});

/* ---------------- publication ---------------- */

function makeSource(name, edits = {}) {

    const dir = path.join(tmp, name);
    const files = { "options.txt": "fov:70" };

    for (const d of ["a", "b", "c"]) for (let i = 0; i < 14; i++) files[`config/${d}/f${i}.json`] = `{"${d}":${i}}`.padEnd(300 + i, " ");
    for (const m of ["alpha", "beta"]) files[`mods/${m}.jar`] = crypto.createHash("sha512").update(m).digest("hex").repeat(1200);     // ~150 Ko : individuel

    for (const [rel, text] of Object.entries({ ...files, ...edits })) {
        const file = path.join(dir, rel);
        if (text === null) { fs.rmSync(file, { force: true }); continue; }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
    }

    return dir;
}

const build = (source, version, archives, extra = {}) =>
    publish.buildManifest({ sourceDir: source, policy, version, manifestsDir: archives, bundleOptions: SMALL_OPTIONS, ...extra });

test("Publication : petits fichiers en bundles, gros fichiers individuels, manifest valide", async () => {
    const r = await build(makeSource("p1"), "1.0.0", path.join(tmp, "arch-vide"));
    const m = r.manifest;

    assert.ok(m.bundles.length >= 3 && m.bundles.length < 20, `${m.bundles.length} bundles`);
    assert.deepStrictEqual(publish.validateManifest(m), []);

    const by = Object.fromEntries(m.files.map((f) => [f.path, f]));
    assert.ok(by["config/a/f1.json"].bundle && !by["config/a/f1.json"].url, "petit fichier : dans un bundle, sans URL");
    assert.ok(by["mods/alpha.jar"].url && !by["mods/alpha.jar"].bundle, "gros fichier : individuel");
    assert.ok(m.bundles.every((b) => b.url.endsWith(`${b.id}.crb`)));

    /* chaque bundle publié = octets dont le SHA-256 est l'id, et contient exactement les contenus annoncés */
    for (const b of m.bundles) {
        const asset = r.newAssets.find((a) => a.assetName === `${b.id}.crb`);
        assert.strictEqual(sha(asset.data), b.id);
        assert.strictEqual(asset.data.length, b.size);
        const entries = parseBundle(asset.data);
        for (const f of m.files.filter((x) => x.bundle === b.id)) assert.ok(entries.has(f.sha256), `${f.path} absent de son bundle`);
    }

    /* moins de fichiers à envoyer qu'en mode individuel */
    const flat = await build(makeSource("p1"), "1.0.0", path.join(tmp, "arch-vide"), { bundles: false });
    assert.ok(r.newAssets.length < flat.newAssets.length / 2, `${r.newAssets.length} contre ${flat.newAssets.length}`);
});

test("Publication : un petit fichier modifié = UN nouveau bundle à envoyer, rien d'autre ; suppression = aucun envoi", async () => {
    const archives = path.join(tmp, "arch-stab");
    const v1 = await build(makeSource("s1"), "1.0.0", archives);
    fs.mkdirSync(archives, { recursive: true });
    fs.writeFileSync(path.join(archives, "manifest-1.0.0.json"), JSON.stringify(v1.manifest));

    const v2 = await build(makeSource("s2", { "config/b/f5.json": "MODIFIE".padEnd(305, " ") }), "1.1.0", archives);
    assert.strictEqual(v2.newAssets.length, 1, v2.newAssets.map((a) => a.assetName).join());
    assert.ok(v2.newAssets[0].assetName.endsWith(".crb"));
    assert.strictEqual(v2.manifest.bundles.filter((b) => !v1.manifest.bundles.some((o) => o.id === b.id)).length, 1);

    const changes = publish.summarizeChanges(v1.manifest, v2.manifest);
    assert.strictEqual(changes.changed, 1);
    assert.strictEqual(changes.downloadBytes, v2.newAssets[0].size, "un joueur télécharge le bundle entier, pas seulement le fichier");

    /* fichier supprimé : le bundle qui le contenait change, mais aucun joueur n'a rien à télécharger */
    const v3 = await build(makeSource("s3", { "config/b/f5.json": null }), "1.2.0", archives);
    assert.strictEqual(publish.summarizeChanges(v1.manifest, v3.manifest).downloadBytes, 0);
    assert.strictEqual(publish.summarizeChanges(v1.manifest, v3.manifest).removed, 1);
});

test("Publication : release « ouverte » (on remplit la dernière, puis on en ouvre une nouvelle)", async () => {
    const archives = path.join(tmp, "arch-open");
    const small = { ...policy, hosting: { ...policy.hosting, maxAssetsPerRelease: 4 } };
    const first = await publish.buildManifest({ sourceDir: makeSource("o1"), policy: small, version: "1.0.0", manifestsDir: archives, bundleOptions: SMALL_OPTIONS });
    const tags1 = [...new Set(first.newAssets.map((a) => a.tag))];
    assert.deepStrictEqual(tags1, tags1.map((_, i) => `pack-files-${i + 1}`), "releases numérotées dans l'ordre");
    assert.ok(first.newAssets.filter((a) => a.tag === "pack-files-1").length === 4);

    fs.mkdirSync(archives, { recursive: true });
    fs.writeFileSync(path.join(archives, "manifest-1.0.0.json"), JSON.stringify(first.manifest));
    const lastTag = tags1[tags1.length - 1];
    const lastCount = first.newAssets.filter((a) => a.tag === lastTag).length;

    /* une mise à jour de 1 bundle : va dans la dernière release ouverte si elle a de la place, sinon dans la suivante */
    const second = await publish.buildManifest({ sourceDir: makeSource("o2", { "config/b/f5.json": "X".padEnd(305, " ") }), policy: small, version: "1.1.0", manifestsDir: archives, bundleOptions: SMALL_OPTIONS });
    assert.strictEqual(second.newAssets.length, 1);
    assert.strictEqual(second.newAssets[0].tag, lastCount < 4 ? lastTag : `pack-files-${tags1.length + 1}`);
    assert.deepStrictEqual([...second.existingTags].sort(), [...tags1].sort());
});

test("Validation du manifest publié : refus des bundles incohérents", async () => {
    const { manifest } = await build(makeSource("v1"), "1.0.0", path.join(tmp, "arch-vide"));
    const refuse = (mutate, fragment) => {
        const m = JSON.parse(JSON.stringify(manifest)); mutate(m);
        assert.ok(publish.validateManifest(m).some((e) => e.includes(fragment)), `attendu '${fragment}'`);
    };
    const bundled = (m) => m.files.find((f) => f.bundle);
    refuse((m) => { bundled(m).bundle = "f".repeat(64); }, "bundle inconnu");
    refuse((m) => { bundled(m).url = "https://github.com/x/y/releases/download/t/a"; }, "n'a pas d'URL");
    refuse((m) => { m.bundles[0].url = "https://evil.example.com/releases/download/t/a.crb"; }, "domaine non autorisé");
    refuse((m) => { m.bundles[0].size = 0; }, "taille invalide");
    refuse((m) => { m.bundles.push({ ...m.bundles[0] }); }, "doublon");
});

/* ---------------- installation de bout en bout ---------------- */

async function harness(fn) {

    const srv = createTestServer();
    const base = await srv.listen();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-bundles-game-"));
    const archives = fs.mkdtempSync(path.join(os.tmpdir(), "cr-bundles-arch-"));
    let n = 0;
    const events = [];

    const env = {
        srv, base, root, events,

        /* publie une version (vrai publish.js) et la sert en local */
        async release(edits, version) {
            const result = await build(makeSource(`h-${++n}`, edits), version, archives);
            fs.writeFileSync(path.join(archives, `manifest-${version}.json`), JSON.stringify(result.manifest));
            const m = JSON.parse(JSON.stringify(result.manifest));
            const nameOf = (u) => decodeURIComponent(u.split("/").pop());
            for (const a of result.newAssets) srv.state.blobs.set(`/f/${a.assetName}`, a.data || fs.readFileSync(a.abs));
            for (const f of m.files) if (f.url) f.url = `${base}/f/${nameOf(f.url)}`;
            for (const b of m.bundles || []) b.url = `${base}/f/${nameOf(b.url)}`;
            srv.state.manifest = m;
            env.manifest = m;
            return { result, manifest: m };
        },

        updater: (options = {}) => createUpdater({
            gameRoot: root, manifestUrl: `${base}/manifest.json`, allowLocal: true, requireSignature: false,
            onProgress: (e) => events.push(e), fetchOptions: { retryDelayMs: 1 }, downloadOptions: { retryDelayMs: 1 }, ...options
        }),

        requests: () => srv.state.requests.filter((r) => r.path.startsWith("/f/")),
        bundleRequests: () => env.requests().filter((r) => r.path.endsWith(".crb")),
        reset: () => { srv.state.requests.length = 0; },
        file: (rel) => path.join(root, rel),
        read: (rel) => fs.readFileSync(path.join(root, rel), "utf8"),
        allConform: () => env.manifest.files.filter((f) => f.policy === "managed").every((f) => { const p = path.join(root, f.path); return fs.existsSync(p) && sha(fs.readFileSync(p)) === f.sha256; })
    };

    try { await fn(env); }
    finally { await srv.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(archives, { recursive: true, force: true }); }
}

const countFiles = (m) => ({ bundles: m.bundles.length, individual: m.files.filter((f) => f.url).length });

test("1. Installation complète : une requête par bundle et par gros fichier, tout est conforme, rien ne reste dans .staging", () => harness(async (env) => {
    const { manifest } = await env.release({}, "1.0.0");
    const r = await env.updater().sync();
    const c = countFiles(manifest);

    assert.ok(r.ok);
    assert.strictEqual(env.requests().length, c.bundles + c.individual, "requêtes = bundles + fichiers individuels");
    assert.ok(env.requests().length < manifest.files.length / 3, `${env.requests().length} requêtes pour ${manifest.files.length} fichiers`);
    assert.ok(env.allConform());
    assert.ok(!fs.existsSync(env.file(".staging")));
    assert.strictEqual(r.downloaded, manifest.files.length - 0, "tous les fichiers installés");
    assert.ok(env.events.some((e) => e.step === "download" && e.percent === 100 && e.filesDone === e.filesTotal), "progression cohérente (fichiers couverts par les bundles inclus)");

    env.reset();
    assert.strictEqual((await env.updater().sync()).downloaded, 0);
    assert.strictEqual(env.requests().length, 0, "installation à jour : aucune requête");
}));

test("2. Un seul petit fichier modifié : un seul bundle téléchargé, le reste intact", () => harness(async (env) => {
    await env.release({}, "1.0.0");
    await env.updater().sync();

    await env.release({ "config/b/f5.json": "MODIFIE v2".padEnd(305, " ") }, "1.1.0");
    env.reset();
    const r = await env.updater().sync();

    assert.strictEqual(env.requests().length, 1, "une seule requête");
    assert.ok(env.requests()[0].path.endsWith(".crb"));
    assert.strictEqual(r.downloaded, 1, "un seul fichier installé");
    assert.ok(env.read("config/b/f5.json").startsWith("MODIFIE v2"));
    assert.ok(env.allConform());
}));

test("3. Plusieurs fichiers dans des bundles différents : seuls ces bundles sont téléchargés", () => harness(async (env) => {
    await env.release({}, "1.0.0");
    await env.updater().sync();

    const edits = { "config/a/f2.json": "A2".padEnd(310, " "), "config/b/f9.json": "B9".padEnd(310, " "), "config/c/f11.json": "C11".padEnd(310, " "), "mods/alpha.jar": "alpha v2".repeat(9000) };
    const { manifest } = await env.release(edits, "1.1.0");
    env.reset();
    const r = await env.updater().sync();

    const touched = new Set(["config/a/f2.json", "config/b/f9.json", "config/c/f11.json"].map((p) => manifest.files.find((f) => f.path === p).bundle));
    assert.strictEqual(env.bundleRequests().length, touched.size, "un bundle par groupe touché, pas plus");
    assert.strictEqual(env.requests().length, touched.size + 1, "+ le mod modifié");
    assert.strictEqual(r.downloaded, 4);
    assert.ok(env.allConform());
}));

test("4. Fichier supprimé d'un bundle : retiré (quarantaine), AUCUN téléchargement", () => harness(async (env) => {
    await env.release({}, "1.0.0");
    await env.updater().sync();

    await env.release({ "config/b/f5.json": null }, "1.1.0");
    env.reset();
    const r = await env.updater().sync();

    assert.ok(r.ok);
    assert.strictEqual(env.requests().length, 0, "rien à télécharger");
    assert.ok(!fs.existsSync(env.file("config/b/f5.json")));
    assert.ok(r.quarantined.includes("config/b/f5.json"));
    assert.ok(fs.existsSync(env.file(".removed")), "mis de côté, pas supprimé");
    assert.ok(env.allConform());
}));

test("5. Téléchargement d'un bundle interrompu : repris là où il s'était arrêté (Range) et vérifié", () => harness(async (env) => {
    const { manifest } = await env.release({}, "1.0.0");
    for (const b of manifest.bundles) env.srv.state.faults.cutAfter[`/f/${b.id}.crb`] = Math.floor(b.size / 3);

    const r = await env.updater().sync();
    assert.ok(r.ok);
    assert.ok(env.allConform());
    const ranges = env.bundleRequests().filter((q) => q.range);
    assert.ok(ranges.length >= manifest.bundles.length, "reprise par Range pour chaque bundle coupé");
}));

test("5b. Arrêt brutal en pleine installation : la reprise ne retélécharge aucun bundle dont les fichiers sont déjà extraits", () => harness(async (env) => {
    await env.release({}, "1.0.0");
    let crashed = false;
    try { await env.updater({ hooks: { afterFile: (n) => { if (n === 20) throw Object.assign(new Error("coupure de courant simulée"), { code: "SIMULATED" }); } } }).sync(); }
    catch { crashed = true; }

    assert.ok(crashed);
    assert.ok(!fs.existsSync(env.file("lock.json")), "installation invalide");
    assert.strictEqual(env.updater().status().valid, false);

    env.reset();
    const r = await env.updater().sync();
    assert.ok(r.ok);
    assert.strictEqual(env.bundleRequests().length, 0, "les fichiers étaient déjà extraits dans .staging : aucun bundle retéléchargé");
    assert.ok(env.allConform());
}));

test("6. Bundle corrompu ou incomplet : refusé, rien n'est installé, erreur claire", () => harness(async (env) => {
    const { manifest } = await env.release({}, "1.0.0");
    const victim = manifest.bundles[0];

    /* a) octet altéré en route */
    env.srv.state.faults.corrupt.add(`/f/${victim.id}.crb`);
    await assert.rejects(env.updater().sync(), (e) => e.code === "CORRUPT" && e.canRepair);
    assert.ok(!fs.existsSync(env.file("lock.json")), "aucune installation partielle déclarée valide");
    assert.ok(!fs.existsSync(env.file("mods")), "rien d'installé dans le jeu");
    env.srv.state.faults.corrupt.clear();

    /* b) bundle tronqué sur le serveur (taille et hash ne correspondent plus) */
    const blob = env.srv.state.blobs.get(`/f/${victim.id}.crb`);
    env.srv.state.blobs.set(`/f/${victim.id}.crb`, blob.subarray(0, blob.length - 5));
    await assert.rejects(env.updater().sync(), (e) => ["CORRUPT", "OFFLINE", "SERVER"].includes(e.code));
    assert.ok(!fs.existsSync(env.file("lock.json")));

    /* c) le serveur est réparé : l'installation aboutit */
    env.srv.state.blobs.set(`/f/${victim.id}.crb`, blob);
    assert.ok((await env.updater().sync()).ok);
    assert.ok(env.allConform());
}));

test("6b. Bundle au bon hash mais dont un fichier ne correspond pas au manifest (erreur de publication) : refusé sans rien installer", () => harness(async (env) => {
    const { manifest } = await env.release({}, "1.0.0");
    const b = manifest.bundles[0];
    const original = parseBundle(env.srv.state.blobs.get(`/f/${b.id}.crb`));
    const wanted = manifest.files.find((f) => f.bundle === b.id);

    /* on remplace le contenu du fichier voulu par un faux, et on recalcule honnêtement le hash du bundle : seule la vérification par fichier peut le voir */
    const blob = env.srv.state.blobs.get(`/f/${b.id}.crb`);
    const entries = [...original].map(([s, p]) => ({ sha256: s, data: s === wanted.sha256 ? Buffer.alloc(p.size, 0x41) : blob.subarray(p.offset, p.offset + p.size) }));   // même taille, contenu faux, étiquette (hash) inchangée
    const forged = buildBundle(entries);
    const forgedId = sha(forged);
    env.srv.state.blobs.set(`/f/${forgedId}.crb`, forged);
    const m = JSON.parse(JSON.stringify(env.srv.state.manifest));
    m.bundles = m.bundles.map((x) => (x.id === b.id ? { id: forgedId, size: forged.length, url: `${env.base}/f/${forgedId}.crb` } : x));
    m.files = m.files.map((f) => (f.bundle === b.id ? { ...f, bundle: forgedId } : f));
    env.srv.state.manifest = m; env.manifest = m;

    await assert.rejects(env.updater().sync(), (e) => e.code === "CORRUPT");
    assert.ok(!fs.existsSync(env.file(wanted.path)), "le faux fichier n'est jamais installé");
    assert.ok(!fs.existsSync(env.file("lock.json")));
}));

test("7. Réparation : un fichier extrait d'un bundle, abîmé ou supprimé, est remis en place (un seul bundle téléchargé)", () => harness(async (env) => {
    const { manifest } = await env.release({}, "1.0.0");
    await env.updater().sync();

    fs.writeFileSync(env.file("config/a/f3.json"), "abîmé");
    fs.rmSync(env.file("config/c/f8.json"));
    env.reset();
    const r = await env.updater().repair();

    const bundles = new Set(["config/a/f3.json", "config/c/f8.json"].map((p) => manifest.files.find((f) => f.path === p).bundle));
    assert.ok(r.ok);
    assert.strictEqual(r.downloaded, 2);
    assert.strictEqual(env.bundleRequests().length, bundles.size);
    assert.ok(env.allConform());
}));

test("8. Retour à une ancienne version : fichiers et mods d'origine rétablis, bundles anciens réutilisés", () => harness(async (env) => {
    const v1 = await env.release({}, "1.0.0");
    await env.updater().sync();
    const v1Manifest = v1.manifest;

    await env.release({ "config/b/f5.json": "V2".padEnd(305, " "), "config/a/f1.json": null, "mods/alpha.jar": "alpha v2".repeat(9000) }, "1.1.0");
    await env.updater().sync();
    assert.ok(env.read("config/b/f5.json").startsWith("V2"));
    assert.ok(!fs.existsSync(env.file("config/a/f1.json")));

    /* retour : on resert l'ancien manifest (les anciens fichiers sont toujours en ligne) */
    env.srv.state.manifest = v1Manifest; env.manifest = v1Manifest;
    env.reset();
    const back = await env.updater().sync();

    assert.ok(back.ok);
    assert.ok(env.allConform());
    assert.ok(fs.existsSync(env.file("config/a/f1.json")), "fichier supprimé par la 1.1.0 revenu");
    assert.ok(!env.read("config/b/f5.json").startsWith("V2"));
    assert.ok(env.read("mods/alpha.jar").length < 200000 && !env.read("mods/alpha.jar").startsWith("alpha v2"));
}));

test("9. Fichiers personnels : intacts après installation, mise à jour, réparation et retour arrière ; mod ajouté à la main mis en quarantaine", () => harness(async (env) => {
    const v1 = await env.release({}, "1.0.0");
    await env.updater().sync();

    const perso = { "saves/Monde/level.dat": "mon monde", "screenshots/a.png": "capture", "config/perso/mes-reglages.json": "à moi", "notes.txt": "notes" };
    for (const [p, c] of Object.entries(perso)) { fs.mkdirSync(path.dirname(env.file(p)), { recursive: true }); fs.writeFileSync(env.file(p), c); }
    fs.writeFileSync(env.file("options.txt"), "fov:99 (réglé par le joueur)");
    fs.writeFileSync(env.file("mods/mod-perso.jar"), "pas dans le modpack");

    const intact = () => Object.entries(perso).every(([p, c]) => env.read(p) === c) && env.read("options.txt") === "fov:99 (réglé par le joueur)";

    await env.release({ "config/b/f5.json": "V2".padEnd(305, " ") }, "1.1.0");
    await env.updater().sync();
    assert.ok(intact(), "après mise à jour");
    assert.ok(!fs.existsSync(env.file("mods/mod-perso.jar")), "mode strict : mod hors modpack en quarantaine");

    fs.writeFileSync(env.file("config/a/f0.json"), "abîmé");
    await env.updater().repair();
    assert.ok(intact(), "après réparation");

    env.srv.state.manifest = v1.manifest; env.manifest = v1.manifest;
    await env.updater().sync();
    assert.ok(intact(), "après retour arrière");
}));

test("Annulation pendant le téléchargement des bundles : fichiers déjà reçus conservés, reprise sans tout recommencer", () => harness(async (env) => {
    const { manifest } = await env.release({}, "1.0.0");
    env.srv.state.faults.throttleBytesPerSec = 200 * 1024;      // assez lent pour annuler en route
    const updater = env.updater();
    const running = updater.sync().catch((e) => e);
    await new Promise((r) => setTimeout(r, 700));
    updater.cancel();
    const outcome = await running;
    assert.strictEqual(outcome.code, "CANCELLED");

    env.srv.state.faults.throttleBytesPerSec = 0;
    env.reset();
    assert.ok((await env.updater().sync()).ok);
    assert.ok(env.requests().length <= manifest.bundles.length + countFiles(manifest).individual, "pas plus de requêtes qu'une installation neuve");
    assert.ok(env.allConform());
}));

(async () => {
    let failed = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`  OK    ${name}`); }
        catch (error) { failed++; console.log(`  ECHEC ${name}\n        ${String(error.stack || error).split("\n").slice(0, 5).join("\n        ")}`); }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failed ? `\n${failed} test(s) en échec` : "\nTous les tests passent");
    process.exit(failed ? 1 : 0);
})();
