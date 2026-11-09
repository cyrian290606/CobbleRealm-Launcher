/*
 * Tests de la signature Ed25519 du manifest. Lancer avec : node test/signature.test.js
 * Clés de TEST uniquement, dossiers temporaires : aucune vraie clé, aucun réseau.
 */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cr-sig-"));
const TRUST = path.join(tmp, "trusted-keys.json");
fs.writeFileSync(TRUST, JSON.stringify({ version: 1, keys: [], revoked: [] }));
process.env.COBBLEREALM_TRUST_FILE = TRUST;        // l'outil d'administration travaille sur une liste de test

const sig = require("../updater/signature");
const keys = require("../tools/keys");
const { createUpdater } = require("../updater");
const { createTestServer } = require("../tools/test-server");

const PASS = "correct-horse-battery-staple";
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const refused = (fn, code = "MANIFEST_SIGNATURE") => { try { fn(); } catch (e) { assert.strictEqual(e.code, code, e.message); return e; } assert.fail("devait être refusé"); };

/* Deux clés de test (principale + secours) et une clé d'attaquant */
const primary = keys.generateKey("primary", PASS);
const backup = keys.generateKey("backup", PASS + "-2");
const attacker = keys.generateKey("primary", "attacker-passphrase-123");
const privateOf = (generated, pass) => sig.decryptPrivateKey(generated.file, pass);
const trusted = () => sig.parseTrustedKeys({ keys: [primary.entry, backup.entry], revoked: [] });

const MANIFEST = Buffer.from(JSON.stringify({ schema: 2, version: "1.0.0", files: [] }, null, 2));

/* ---------------- clés ---------------- */

test("Clé privée : jamais en clair dans le fichier, relue avec le bon mot de passe seulement", () => {
    const original = crypto.generateKeyPairSync("ed25519").privateKey;
    const file = sig.encryptPrivateKey(original, PASS);
    const text = JSON.stringify(file);
    const pkcs8 = original.export({ format: "der", type: "pkcs8" });

    assert.ok(!text.includes(pkcs8.toString("base64")), "clé en clair dans le fichier");
    assert.ok(!text.includes(pkcs8.subarray(16).toString("base64")), "clé brute dans le fichier");
    assert.deepStrictEqual(sig.decryptPrivateKey(file, PASS).export({ format: "der", type: "pkcs8" }), pkcs8);
    assert.throws(() => sig.decryptPrivateKey(file, PASS + "x"), /mot de passe incorrect/);
    assert.throws(() => sig.decryptPrivateKey({ ...file, data: Buffer.from("abîmé").toString("base64") }, PASS), /incorrect|abîmé/);
    assert.throws(() => sig.encryptPrivateKey(original, "court"), /trop court/);
    assert.throws(() => sig.decryptPrivateKey({ kind: "autre" }, PASS), /pas une clé privée/);
});

test("Dossier de clés : refusé dans le dépôt du launcher ou dans tout dépôt Git, accepté ailleurs", () => {
    assert.throws(() => keys.assertSafeKeyDir(path.join(keys.REPO_ROOT, "cles")), /dans le dépôt du launcher/);
    assert.throws(() => keys.assertSafeKeyDir(keys.REPO_ROOT), /dans le dépôt/);

    const other = path.join(tmp, "autre-depot"); fs.mkdirSync(path.join(other, ".git"), { recursive: true });
    assert.throws(() => keys.assertSafeKeyDir(path.join(other, "sous", "dossier")), /dépôt Git/);

    assert.ok(keys.assertSafeKeyDir(path.join(tmp, "cles-ok")));
});

test("Aucune clé privée dans le dépôt ; une clé déposée par erreur est détectée", () => {
    assert.deepStrictEqual(keys.findPrivateKeysInRepo(), []);

    const fake = path.join(tmp, "faux-depot"); fs.mkdirSync(fake, { recursive: true });
    fs.writeFileSync(path.join(fake, "oups.key.json"), JSON.stringify(primary.file));
    fs.writeFileSync(path.join(fake, "pem.txt"), "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
    fs.writeFileSync(path.join(fake, "propre.json"), "{\"a\":1}");
    assert.deepStrictEqual(keys.findPrivateKeysInRepo(fake).sort(), ["oups.key.json", "pem.txt"]);
});

test("Le launcher embarque uniquement des clés PUBLIQUES (liste de confiance valide, sans clé privée)", () => {
    const text = fs.readFileSync(sig.TRUSTED_KEYS_FILE, "utf8");
    assert.ok(!text.includes(sig.PRIVATE_KEY_MARKER));
    assert.ok(sig.parseTrustedKeys(JSON.parse(text)), "format valide");
    for (const k of JSON.parse(text).keys) assert.strictEqual(Buffer.from(k.publicKey, "base64").length, 32);
});

/* ---------------- vérification : acceptation ---------------- */

test("Manifest signé par la clé principale ou la clé de secours : accepté", () => {
    const t = trusted();
    const ok1 = sig.verifyManifestSignature(MANIFEST, sig.signBytes(MANIFEST, privateOf(primary, PASS)), t);
    assert.deepStrictEqual([ok1.keyId, ok1.role], [primary.entry.id, "primary"]);
    const ok2 = sig.verifyManifestSignature(MANIFEST, sig.signBytes(MANIFEST, privateOf(backup, PASS + "-2")), t);
    assert.deepStrictEqual([ok2.keyId, ok2.role], [backup.entry.id, "backup"]);
});

/* ---------------- vérification : refus ---------------- */

test("Refus : manifest modifié d'un seul octet, ajouté, tronqué ou remplacé", () => {
    const t = trusted();
    const good = sig.signBytes(MANIFEST, privateOf(primary, PASS));

    for (const tampered of [
        Buffer.concat([MANIFEST.subarray(0, 10), Buffer.from("X"), MANIFEST.subarray(11)]),
        Buffer.concat([MANIFEST, Buffer.from("\n")]),
        MANIFEST.subarray(0, MANIFEST.length - 1),
        Buffer.from(MANIFEST.toString().replace("1.0.0", "1.0.1")),
        Buffer.from("{}")
    ]) {
        const e = refused(() => sig.verifyManifestSignature(tampered, good, t));
        assert.match(e.message, /signature de la liste de mise à jour est invalide/);
    }
});

test("Refus : non signé, signature illisible, algorithme inconnu, signature tronquée ou altérée", () => {
    const t = trusted();
    const good = sig.signBytes(MANIFEST, privateOf(primary, PASS));

    assert.match(refused(() => sig.verifyManifestSignature(MANIFEST, null, t)).message, /n'est pas signée/);
    for (const bad of [{}, "texte", 42, [], { ...good, alg: "rsa" }, { ...good, signature: 5 }, { ...good, keyId: undefined },
        { ...good, signature: good.signature.slice(0, -8) }, { ...good, signature: Buffer.alloc(64).toString("base64") },
        { ...good, signature: Buffer.from(good.signature, "base64").map((b, i) => (i === 0 ? b ^ 1 : b)).toString("base64") }]) {
        refused(() => sig.verifyManifestSignature(MANIFEST, bad, t));
    }
});

test("Refus : clé inconnue, clé d'un attaquant (même en se faisant passer pour une clé de confiance), clé révoquée, aucune clé configurée", () => {
    const t = trusted();
    const byAttacker = sig.signBytes(MANIFEST, privateOf(attacker, "attacker-passphrase-123"));
    assert.match(refused(() => sig.verifyManifestSignature(MANIFEST, byAttacker, t)).message, /clé inconnue/);

    /* l'attaquant revendique l'identifiant de la clé principale : la signature ne correspond pas */
    refused(() => sig.verifyManifestSignature(MANIFEST, { ...byAttacker, keyId: primary.entry.id }, t));

    /* une clé révoquée est refusée même si elle figure encore dans la liste */
    const revoked = sig.parseTrustedKeys({ keys: [primary.entry, backup.entry], revoked: [primary.entry.id] });
    const byPrimary = sig.signBytes(MANIFEST, privateOf(primary, PASS));
    assert.match(refused(() => sig.verifyManifestSignature(MANIFEST, byPrimary, revoked)).message, /révoquée/);
    sig.verifyManifestSignature(MANIFEST, sig.signBytes(MANIFEST, privateOf(backup, PASS + "-2")), revoked);     // la clé de secours prend le relais

    /* aucune clé de confiance (launcher mal configuré) : tout est refusé, jamais accepté par défaut */
    assert.match(refused(() => sig.verifyManifestSignature(MANIFEST, byPrimary, { keys: [], revoked: new Set() })).message, /pas configurée/);
    refused(() => sig.verifyManifestSignature(MANIFEST, byPrimary, null));
});

test("Refus : la signature d'un autre fichier ne vaut pas pour celui-ci", () => {
    const other = Buffer.from("{\"autre\":true}");
    refused(() => sig.verifyManifestSignature(MANIFEST, sig.signBytes(other, privateOf(primary, PASS)), trusted()));
});

test("Liste de confiance corrompue ou falsifiée : refusée", () => {
    assert.throws(() => sig.parseTrustedKeys({ keys: [{ publicKey: "AAAA" }] }), /32 octets/);
    assert.throws(() => sig.parseTrustedKeys({ keys: [{ ...primary.entry, id: "0000000000000000" }] }), /ne correspond pas/);
    assert.throws(() => sig.parseTrustedKeys(null), /invalide/);
    assert.throws(() => sig.parseTrustedKeys({}), /invalide/);
});

/* ---------------- outil d'administration ---------------- */

test("Outil : signature d'un fichier, relecture, refus d'une clé absente de la liste de confiance", () => {
    fs.writeFileSync(TRUST, JSON.stringify({ version: 1, keys: [primary.entry, backup.entry], revoked: [] }));

    const manifest = path.join(tmp, "manifest.json");
    fs.writeFileSync(manifest, MANIFEST);
    const keyFile = path.join(tmp, "primary.key.json");
    fs.writeFileSync(keyFile, JSON.stringify(primary.file));

    const result = keys.signFile(manifest, keyFile, PASS);
    assert.strictEqual(result.keyId, primary.entry.id);
    assert.strictEqual(keys.verifyFile(manifest).role, "primary");
    assert.throws(() => keys.signFile(manifest, keyFile, "mauvais-mot-de-passe"), /incorrect/);

    /* modifié après signature : refusé */
    fs.appendFileSync(manifest, " ");
    refused(() => keys.verifyFile(manifest));

    /* clé d'attaquant : l'outil refuse de signer (les launchers refuseraient de toute façon) */
    const attackerFile = path.join(tmp, "attacker.key.json");
    fs.writeFileSync(attackerFile, JSON.stringify(attacker.file));
    refused(() => keys.signFile(manifest, attackerFile, "attacker-passphrase-123"));

    /* rotation : la clé révoquée n'est plus acceptée, la nouvelle l'est */
    const next = keys.generateKey("primary", "nouvelle-cle-principale-1");
    fs.writeFileSync(TRUST, JSON.stringify({ version: 1, keys: [primary.entry, backup.entry, next.entry], revoked: [primary.entry.id] }));
    fs.writeFileSync(manifest, MANIFEST);
    refused(() => keys.signFile(manifest, keyFile, PASS), "MANIFEST_SIGNATURE");
    const nextFile = path.join(tmp, "next.key.json");
    fs.writeFileSync(nextFile, JSON.stringify(next.file));
    assert.strictEqual(keys.signFile(manifest, nextFile, "nouvelle-cle-principale-1").keyId, next.entry.id);

    fs.writeFileSync(TRUST, JSON.stringify({ version: 1, keys: [primary.entry, backup.entry], revoked: [] }));
});

test("Test de restauration : retrouve les copies de clés, prouve qu'elles fonctionnent, refuse un mauvais mot de passe", () => {
    fs.writeFileSync(TRUST, JSON.stringify({ version: 1, keys: [primary.entry, backup.entry], revoked: [] }));
    const usb = path.join(tmp, "cle-usb", "sauvegarde"); fs.mkdirSync(usb, { recursive: true });
    fs.writeFileSync(path.join(usb, `primary-${primary.entry.id}.key.json`), JSON.stringify(primary.file));
    fs.writeFileSync(path.join(usb, "autre-fichier.json"), "{}");

    const found = keys.findKeyCopies([path.join(tmp, "cle-usb")]);
    assert.deepStrictEqual(found.map((f) => path.basename(f)), [`primary-${primary.entry.id}.key.json`]);

    assert.strictEqual(keys.testKeyFile(found[0], PASS).role, "primary");
    assert.throws(() => keys.testKeyFile(found[0], "mauvais-mot-de-passe-123"), /incorrect/);
    assert.deepStrictEqual(fs.readdirSync(usb).sort(), [`primary-${primary.entry.id}.key.json`, "autre-fichier.json"].sort(), "rien n'est écrit sur le support");
});

/* ---------------- de bout en bout : updater + serveur ---------------- */

async function withServer({ signer, trustedKeys = trusted() }, fn) {

    const srv = createTestServer({ signer });
    const base = await srv.listen();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-sigupd-"));
    const blob = Buffer.from("contenu du mod");
    const put = (version, extra = {}) => {
        srv.state.blobs.set(`/f/${sha(blob)}`, blob);
        srv.state.manifest = { schema: 2, version, minecraft: "1.21.1", fabricLoader: "0.18.4", java: 21, recommendedRamGb: 6, strictDirs: [], files: [
            { path: "mods/a.jar", size: blob.length, sha256: sha(blob), url: `${base}/f/${sha(blob)}`, policy: "managed" }], ...extra };
    };
    const updater = (options = {}) => createUpdater({ gameRoot: root, manifestUrl: `${base}/manifest.json`, allowLocal: true, trustedKeys,
        fetchOptions: { retries: 1, retryDelayMs: 1 }, downloadOptions: { retryDelayMs: 1 }, ...options });
    try { await fn({ srv, base, root, put, updater, fileRequests: () => srv.state.requests.filter((r) => r.path.startsWith("/f/")) }); }
    finally { await srv.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }
}

const signerOf = (generated, pass) => { const k = privateOf(generated, pass); return (bytes) => sig.signBytes(bytes, k); };

test("Bout en bout : manifest signé = installation ; clé de secours acceptée", async () => {
    await withServer({ signer: signerOf(primary, PASS) }, async ({ put, updater, root }) => {
        put("1.0.0");
        const r = await updater().sync();
        assert.ok(r.ok);
        assert.ok(fs.existsSync(path.join(root, "mods/a.jar")));
    });
    await withServer({ signer: signerOf(backup, PASS + "-2") }, async ({ put, updater }) => {
        put("1.0.0");
        assert.ok((await updater().sync()).ok);
    });
});

test("Bout en bout : manifest NON signé refusé, rien n'est téléchargé ni installé", async () => {
    await withServer({ signer: null }, async ({ put, updater, root, fileRequests }) => {
        put("1.0.0");
        await assert.rejects(updater().sync(), (e) => e.code === "MANIFEST_SIGNATURE" && /n'est pas signée/.test(e.message));
        assert.strictEqual(fileRequests().length, 0, "aucun téléchargement");
        assert.ok(!fs.existsSync(path.join(root, "mods")), "rien d'installé");
        const check = await updater().check().catch((e) => e);
        assert.strictEqual(check.code, "MANIFEST_SIGNATURE", "la vérification au démarrage refuse aussi");
    });
});

test("Bout en bout : manifest MODIFIÉ après signature (fichier remplacé par un faux) refusé", async () => {
    let frozen = null;
    await withServer({ signer: (bytes) => { if (!frozen) frozen = signerOf(primary, PASS)(bytes); return frozen; } }, async ({ srv, put, updater, root, fileRequests }) => {
        put("1.0.0");
        await updater().sync();                                   // installation légitime (la signature est mémorisée)
        const before = fs.readFileSync(path.join(root, "mods/a.jar"), "utf8");

        /* l'attaquant remplace le fichier par un faux, avec le bon hash, en gardant l'ancienne signature */
        const evil = Buffer.from("MOD PIRATÉ");
        srv.state.blobs.set(`/f/${sha(evil)}`, evil);
        srv.state.manifest.files[0] = { ...srv.state.manifest.files[0], size: evil.length, sha256: sha(evil), url: srv.state.manifest.files[0].url.replace(/[0-9a-f]{64}$/, sha(evil)) };
        fileRequests().length = 0; srv.state.requests.length = 0;

        await assert.rejects(updater().sync(), (e) => e.code === "MANIFEST_SIGNATURE");
        assert.strictEqual(fileRequests().length, 0, "le faux fichier n'est jamais téléchargé");
        assert.strictEqual(fs.readFileSync(path.join(root, "mods/a.jar"), "utf8"), before, "installation intacte");
    });
});

test("Bout en bout : signature refusée = jamais de « mode hors-ligne » (une installation valide n'est pas lancée à la place)", async () => {
    await withServer({ signer: signerOf(primary, PASS) }, async ({ srv, put, updater }) => {
        put("1.0.0");
        await updater().sync();
        srv.state.signer = null;                                  // le serveur ne signe plus (compte piraté, fichier supprimé...)
        await assert.rejects(updater().sync(), (e) => e.code === "MANIFEST_SIGNATURE");
    });
});

test("Bout en bout : clé d'un attaquant, clé révoquée et liste de confiance vide refusées", async () => {
    await withServer({ signer: signerOf(attacker, "attacker-passphrase-123") }, async ({ put, updater }) => {
        put("1.0.0");
        await assert.rejects(updater().sync(), (e) => e.code === "MANIFEST_SIGNATURE" && /clé inconnue/.test(e.message));
    });
    const revoked = sig.parseTrustedKeys({ keys: [primary.entry, backup.entry], revoked: [primary.entry.id] });
    await withServer({ signer: signerOf(primary, PASS), trustedKeys: revoked }, async ({ put, updater }) => {
        put("1.0.0");
        await assert.rejects(updater().sync(), (e) => e.code === "MANIFEST_SIGNATURE" && /révoquée/.test(e.message));
    });
    await withServer({ signer: signerOf(primary, PASS), trustedKeys: { keys: [], revoked: new Set() } }, async ({ put, updater }) => {
        put("1.0.0");
        await assert.rejects(updater().sync(), (e) => e.code === "MANIFEST_SIGNATURE" && /pas configurée/.test(e.message));
    });
});

test("Par défaut la signature est OBLIGATOIRE (oublier l'option ne désactive jamais la vérification)", async () => {
    await withServer({ signer: null }, async ({ put, srv, base, root }) => {
        put("1.0.0");
        const u = createUpdater({ gameRoot: root, manifestUrl: `${base}/manifest.json`, allowLocal: true, fetchOptions: { retries: 1, retryDelayMs: 1 } });
        await assert.rejects(u.sync(), (e) => e.code === "MANIFEST_SIGNATURE");
    });
    const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
    assert.match(main, /ALLOW_UNSIGNED_MANIFEST = DEV_MODE && process\.env\.COBBLEREALM_ALLOW_UNSIGNED === "1"/, "désactivation impossible hors mode développement");
    assert.match(main, /TRUST_KEYS_FILE = \(DEV_MODE && /, "clés de test impossibles hors mode développement");
    assert.match(main, /requireSignature: !ALLOW_UNSIGNED_MANIFEST/);
});

/* ---------------- publication ---------------- */

test("Publication : --sign signe le manifest publié ; sans --sign, avertissement ; la source modifiée ensuite n'altère pas les fichiers à envoyer", () => {
    const source = path.join(tmp, "src"); fs.mkdirSync(path.join(source, "mods"), { recursive: true });
    fs.writeFileSync(path.join(source, "mods", "a.jar"), "contenu-original");
    fs.writeFileSync(path.join(source, "mods", "b.jar"), "autre");
    fs.writeFileSync(path.join(source, "options.txt"), "fov:70");

    const keyFile = path.join(tmp, "primary.key.json");
    fs.writeFileSync(keyFile, JSON.stringify(primary.file));
    fs.writeFileSync(TRUST, JSON.stringify({ version: 1, keys: [primary.entry, backup.entry], revoked: [] }));

    const run = (extra, outName) => spawnSync(process.execPath, [path.join(__dirname, "..", "tools", "publish.js"), source, "--version", "1.0.0", "--out", path.join(tmp, outName), "--no-bundles", ...extra],
        { encoding: "utf8", env: { ...process.env, PUBLISH_REPO_ROOT: path.join(tmp, "repo-" + outName), COBBLEREALM_KEY_PASSPHRASE: PASS } });

    const unsigned = run([], "out-nosign");
    assert.strictEqual(unsigned.status, 0, unsigned.stderr);
    assert.match(unsigned.stderr, /NON signé/);
    assert.ok(!fs.existsSync(path.join(tmp, "out-nosign", "docs", "manifest.json.sig")));

    const signedRun = run(["--sign", keyFile], "out-sign");
    assert.strictEqual(signedRun.status, 0, signedRun.stderr + signedRun.stdout);
    const published = path.join(tmp, "out-sign", "docs", "manifest.json");
    assert.strictEqual(keys.verifyFile(published).keyId, primary.entry.id);
    assert.ok(fs.existsSync(path.join(tmp, "repo-out-sign", "manifests", "manifest-1.0.0.json.sig")), "signature archivée avec le manifest (retour arrière)");
    assert.match(fs.readFileSync(path.join(tmp, "out-sign", "UPLOAD.md"), "utf8"), /manifest\.json\.sig/);

    /* modifier la source APRÈS la préparation ne doit pas toucher aux fichiers à envoyer */
    fs.writeFileSync(path.join(source, "mods", "a.jar"), "contenu-MODIFIE-apres");
    const manifest = JSON.parse(fs.readFileSync(published, "utf8"));
    for (const f of manifest.files) {
        const asset = fs.readdirSync(path.join(tmp, "out-sign")).filter((d) => d.startsWith("release-")).flatMap((d) => fs.readdirSync(path.join(tmp, "out-sign", d)).map((n) => path.join(tmp, "out-sign", d, n)))
            .find((p) => path.basename(p).startsWith(f.sha256));
        assert.strictEqual(sha(fs.readFileSync(asset)), f.sha256, `${f.path} : le fichier à envoyer ne correspond plus à son hash`);
    }

    /* signer avec une clé inconnue de la liste : la publication échoue */
    const stranger = path.join(tmp, "stranger.key.json");
    fs.writeFileSync(stranger, JSON.stringify(attacker.file));
    const bad = spawnSync(process.execPath, [path.join(__dirname, "..", "tools", "publish.js"), source, "--version", "1.0.1", "--out", path.join(tmp, "out-bad"), "--sign", stranger],
        { encoding: "utf8", env: { ...process.env, PUBLISH_REPO_ROOT: path.join(tmp, "repo-bad"), COBBLEREALM_KEY_PASSPHRASE: "attacker-passphrase-123" } });
    assert.notStrictEqual(bad.status, 0);
});

(async () => {
    let failed = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`  OK    ${name}`); }
        catch (error) { failed++; console.log(`  ECHEC ${name}\n        ${String(error.stack || error).split("\n").slice(0, 4).join("\n        ")}`); }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failed ? `\n${failed} test(s) en échec` : "\nTous les tests passent");
    process.exit(failed ? 1 : 0);
})();
