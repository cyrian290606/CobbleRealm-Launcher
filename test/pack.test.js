/*
 * Tests de la préparation du dépôt CobbleRealm-Pack, de la publication vers ce dépôt et de l'envoi des releases.
 * Lancer avec : node test/pack.test.js   (aucun réseau, aucun GitHub : « gh » est simulé)
 */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cr-pack-"));
const TRUST = path.join(tmp, "trusted-keys.json");
fs.writeFileSync(TRUST, JSON.stringify({ version: 1, keys: [], revoked: [] }));
process.env.COBBLEREALM_TRUST_FILE = TRUST;

const keys = require("../tools/keys");
const { preparePack } = require("../tools/pack-prepare");
const { uploadRelease } = require("../tools/upload-release");

const ROOT = path.resolve(__dirname, "..");
const PASS = "mot-de-passe-de-test-12345";
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });

/* ---------------- dépôt Pack local ---------------- */

test("Préparation du dépôt Pack : fichiers du modèle, Git local sur main, AUCUN dépôt distant, aucune conversion de contenu", () => {
    const dir = path.join(tmp, "Pack");
    const r = preparePack(dir);

    assert.strictEqual(r.branch, "main");
    assert.strictEqual(r.remotes, "", "aucun dépôt distant : rien ne peut être publié");
    for (const f of ["README.md", ".gitattributes", ".gitignore", "docs/.nojekyll", "manifests/.gitkeep"]) assert.ok(fs.existsSync(path.join(dir, f)), f);

    assert.match(fs.readFileSync(path.join(dir, ".gitattributes"), "utf8"), /\* -text/, "aucune conversion de fin de ligne (signature)");
    const ignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    for (const pattern of ["publish-out/", "*.key.json", "*.pem"]) assert.ok(ignore.includes(pattern), pattern);
    assert.strictEqual(git(dir, "config", "core.autocrlf").stdout.trim(), "false");
    assert.match(git(dir, "log", "--oneline").stdout, /Structure initiale/);
    assert.strictEqual(git(dir, "status", "--short").stdout.trim(), "", "dépôt propre après le premier commit");
});

test("Préparation du dépôt Pack : refuse un dossier non vide ou situé dans le dépôt du launcher", () => {
    const full = path.join(tmp, "plein"); fs.mkdirSync(full); fs.writeFileSync(path.join(full, "a.txt"), "x");
    assert.throws(() => preparePack(full), /pas vide/);
    assert.throws(() => preparePack(path.join(ROOT, "Pack-test")), /dans le dépôt du launcher/);
    assert.ok(!fs.existsSync(path.join(ROOT, "Pack-test")));
});

/* ---------------- publication vers le dépôt Pack ---------------- */

test("publish --pack --sign --write-docs : docs/, signature, archives et sortie dans le dépôt Pack (jamais dans celui du launcher) ; Git ne modifie pas un octet", () => {
    const primary = keys.generateKey("primary", PASS);
    fs.writeFileSync(TRUST, JSON.stringify({ version: 1, keys: [primary.entry], revoked: [] }));
    const keyFile = path.join(tmp, "primary.key.json"); fs.writeFileSync(keyFile, JSON.stringify(primary.file));

    const pack = path.join(tmp, "Pack2"); preparePack(pack);
    const source = path.join(tmp, "src");
    for (const [rel, text] of Object.entries({ "mods/a.jar": "alpha", "mods/b.jar": "beta", "config/x/c.json": "{}" })) { fs.mkdirSync(path.dirname(path.join(source, rel)), { recursive: true }); fs.writeFileSync(path.join(source, rel), text); }

    const before = fs.existsSync(path.join(ROOT, "manifests"));
    const r = spawnSync(process.execPath, [path.join(ROOT, "tools", "publish.js"), source, "--version", "1.0.0", "--pack", pack, "--sign", keyFile, "--write-docs"],
        { encoding: "utf8", env: { ...process.env, COBBLEREALM_KEY_PASSPHRASE: PASS } });
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);

    for (const f of ["docs/manifest.json", "docs/manifest.json.sig", "manifests/manifest-1.0.0.json", "manifests/manifest-1.0.0.json.sig", "publish-out/UPLOAD.md"]) assert.ok(fs.existsSync(path.join(pack, f)), f);
    assert.strictEqual(fs.existsSync(path.join(ROOT, "manifests")), before, "rien n'est écrit dans le dépôt du launcher");

    const manifest = JSON.parse(fs.readFileSync(path.join(pack, "docs", "manifest.json"), "utf8"));
    assert.ok(manifest.bundles && manifest.bundles.length >= 1, "petits fichiers regroupés");
    assert.match(fs.readFileSync(path.join(pack, "publish-out", "UPLOAD.md"), "utf8"), /upload-release\.js.*--tag pack-files-1.*--create/);

    /* publish-out/ est ignoré par Git ; docs et manifests sont suivis ; le fichier commité a EXACTEMENT les mêmes octets */
    git(pack, "add", "-A");
    const staged = git(pack, "diff", "--cached", "--name-only").stdout.trim().split("\n").sort();
    assert.ok(!staged.some((f) => f.startsWith("publish-out")), "les 3 Go de fichiers ne vont jamais dans Git");
    assert.deepStrictEqual(staged, ["docs/manifest.json", "docs/manifest.json.sig", "manifests/manifest-1.0.0.json", "manifests/manifest-1.0.0.json.sig"]);
    git(pack, "commit", "-q", "-m", "publication 1.0.0");
    for (const f of ["docs/manifest.json", "docs/manifest.json.sig"]) {
        const committed = spawnSync("git", ["show", `HEAD:${f}`], { cwd: pack, encoding: "buffer", maxBuffer: 1 << 26 }).stdout;
        assert.ok(committed.equals(fs.readFileSync(path.join(pack, f))), `${f} : Git a modifié des octets`);
    }

    /* --check : signature valide ; falsifié ou non signé : refusé */
    const check = (file) => spawnSync(process.execPath, [path.join(ROOT, "tools", "publish.js"), "--check", file, "--signature-only"], { encoding: "utf8", env: process.env });
    const ok = check(path.join(pack, "docs", "manifest.json"));
    assert.strictEqual(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Signature valide/);

    const tampered = path.join(tmp, "falsifie.json");
    fs.copyFileSync(path.join(pack, "docs", "manifest.json"), tampered);
    fs.copyFileSync(path.join(pack, "docs", "manifest.json.sig"), `${tampered}.sig`);
    fs.appendFileSync(tampered, " ");
    const bad = check(tampered);
    assert.strictEqual(bad.status, 1);
    assert.match(bad.stderr, /SIGNATURE REFUSÉE/);

    const unsigned = path.join(tmp, "non-signe.json");
    fs.copyFileSync(path.join(pack, "docs", "manifest.json"), unsigned);
    assert.strictEqual(check(unsigned).status, 1);
});

/* ---------------- envoi des releases (gh simulé) ---------------- */

const FAKE_GH = path.join(tmp, "fake-gh.js");
fs.writeFileSync(FAKE_GH, `
const fs = require("fs"), path = require("path");
const state = process.env.FAKE_GH_STATE; const db = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, "utf8")) : { releases: {}, calls: [], uploads: 0 };
const save = () => fs.writeFileSync(state, JSON.stringify(db));
const a = process.argv.slice(2); db.calls.push(a.slice(0, 2).join(" "));
const tag = a[2];
if (a[0] === "release" && a[1] === "view") { save(); if (!db.releases[tag]) { process.stderr.write("release not found"); process.exit(1); } console.log(JSON.stringify({ assets: Object.entries(db.releases[tag]).map(([name, size]) => ({ name, size })) })); }
else if (a[0] === "release" && a[1] === "create") { db.releases[tag] = {}; save(); }
else if (a[0] === "release" && a[1] === "upload") {
  db.uploads++; const files = a.slice(a.indexOf("--repo") + 2);
  db.batches = (db.batches || []).concat([files.length]);
  if (process.env.FAKE_GH_FAIL_AT && db.uploads === Number(process.env.FAKE_GH_FAIL_AT)) { save(); process.stderr.write("HTTP 502"); process.exit(1); }
  if (process.env.FAKE_GH_FAIL_FROM && db.uploads >= Number(process.env.FAKE_GH_FAIL_FROM)) { save(); process.stderr.write("HTTP 502"); process.exit(1); }
  for (const f of files) { if (db.releases[tag][path.basename(f)] !== undefined) { save(); process.stderr.write("asset already exists"); process.exit(1); } if (process.env.FAKE_GH_DROP && path.basename(f) === process.env.FAKE_GH_DROP) continue; db.releases[tag][path.basename(f)] = fs.statSync(f).size; }
  save();
}
`);

function releaseDir(name, count) {
    const dir = path.join(tmp, name); fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < count; i++) fs.writeFileSync(path.join(dir, `${sha(String(i))}.crb`), "x".repeat(10 + i));
    return dir;
}

function withFakeGh(extraEnv, fn) {
    const state = path.join(tmp, `gh-state-${Math.random().toString(36).slice(2)}.json`);
    const saved = { ...process.env };
    Object.assign(process.env, { GH_COMMAND: JSON.stringify([process.execPath, FAKE_GH]), FAKE_GH_STATE: state, UPLOAD_RETRY_MS: "1", ...extraEnv });
    try { return fn(() => JSON.parse(fs.readFileSync(state, "utf8"))); }
    finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
}

const run = (dir, options = {}) => uploadRelease({ dir, tag: "pack-files-1", repo: "o/r", log: () => {}, ...options });

test("Envoi : simulation, création, envoi par lots, vérification finale", () => {
    const dir = releaseDir("rel1", 45);

    withFakeGh({}, (db) => {
        assert.deepStrictEqual(run(dir, { create: true, dryRun: true }), { total: 45, sent: 0, missing: 45 });
        assert.ok(!db().calls.some((c) => c === "release upload" || c === "release create"), "simulation : aucun envoi, aucune création");
    });

    withFakeGh({}, (db) => {
        assert.throws(() => run(dir, {}), /n'existe pas.*--create/, "release absente sans --create");
        const r = run(dir, { create: true, batch: 20 });
        assert.strictEqual(r.sent, 45);
        assert.deepStrictEqual(db().batches, [20, 20, 5], "lots de 20 (jamais une commande géante)");
        assert.strictEqual(Object.keys(db().releases["pack-files-1"]).length, 45);
    });
});

test("Envoi : un envoi interrompu REPREND sans renvoyer ce qui est déjà en ligne", () => {
    const dir = releaseDir("rel2", 60);
    const state = path.join(tmp, "gh-state-resume.json");
    const env = { GH_COMMAND: JSON.stringify([process.execPath, FAKE_GH]), FAKE_GH_STATE: state, UPLOAD_RETRY_MS: "1" };
    const saved = { ...process.env };

    try {
        Object.assign(process.env, env, { FAKE_GH_FAIL_FROM: "3" });             // GitHub répond 502 à partir du 3e lot
        assert.throws(() => run(dir, { create: true, batch: 20 }), /Échec de l'envoi après 3 essais.*Relance/s);
        const afterFailure = JSON.parse(fs.readFileSync(state, "utf8"));
        assert.strictEqual(Object.keys(afterFailure.releases["pack-files-1"]).length, 40, "2 lots arrivés");

        delete process.env.FAKE_GH_FAIL_FROM;                                       // GitHub revient
        const r = run(dir, { create: true, batch: 20 });
        assert.strictEqual(r.sent, 20, "seuls les 20 manquants sont envoyés");
        assert.strictEqual(Object.keys(JSON.parse(fs.readFileSync(state, "utf8")).releases["pack-files-1"]).length, 60);
    } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});

test("Envoi : jamais d'écrasement (fichier existant de taille différente = arrêt) ; fichier perdu en route détecté à la vérification finale", () => {
    const dir = releaseDir("rel3", 6);

    withFakeGh({}, (db) => {
        run(dir, { create: true });
        const name = fs.readdirSync(dir)[0];
        fs.writeFileSync(path.join(dir, name), "contenu différent et plus long");
        assert.throws(() => run(dir, {}), /AUTRE taille.*n'écrase jamais/s);
        assert.strictEqual(db().uploads, 1, "rien de plus n'a été envoyé");
    });

    const dir4 = releaseDir("rel4", 6);
    withFakeGh({ FAKE_GH_DROP: `${sha("3")}.crb` }, () => {
        assert.throws(() => run(dir4, { create: true }), /absents ou incomplets en ligne/);
    });
});

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
