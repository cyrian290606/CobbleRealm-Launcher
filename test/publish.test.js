/*
 * Tests de tools/publish.js. Lancer avec : node test/publish.test.js
 * Tout se passe dans un dossier temporaire ; le dépôt n'est jamais modifié.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const publish = require("../tools/publish.js");
const policy = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "tools", "policy.json"), "utf8"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cr-publish-"));
const write = (root, rel, content) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
};
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/* Dossier source de démonstration */
function makeSource(name, overrides = {}) {
    const dir = path.join(tmp, name);
    const files = {
        "mods/alpha.jar": "alpha-v1",
        "mods/beta.jar": "beta-v1",
        "mods/vieux.jar.disabled": "desactive",
        "config/cobblemon/main.json": "{\"a\":1}",
        "config/xaerominimap/settings.txt": "perso",
        "options.txt": "fov:70",
        "servers.dat": "serveurs",
        "resourcepacks/pack.zip": "pack",
        "saves/monde/level.dat": "SAUVEGARDE",
        "screenshots/a.png": "png",
        "logs/latest.log": "log",
        "inconnu.bin": "?",
        ...overrides
    };
    for (const [rel, content] of Object.entries(files)) {
        if (content !== null) write(dir, rel, content);
    }
    return dir;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const build = (sourceDir, version, manifestsDir, extra = {}) =>
    publish.buildManifest({ sourceDir, policy, version, manifestsDir, bundles: false, ...extra });

/* ---------------- chemins et motifs ---------------- */

test("Chemins dangereux refusés", () => {
    const bad = ["../x", "a/../b", "/etc/passwd", "C:/Windows/x", "a\\b", "a//b", "a/./b", "con.txt",
        "dossier/nul", "fichier.", "a:b", "a/b?.txt", ""];
    for (const p of bad) assert.ok(publish.validateRelPath(p), `devrait refuser '${p}'`);
    for (const p of ["mods/a.jar", "config/x/y.json", "options.txt"]) {
        assert.strictEqual(publish.validateRelPath(p), null, p);
    }
});

test("Classement : managed / default / preserved", () => {
    const rules = publish.compileRules(policy);
    const c = (p) => publish.classify(p, rules, "default");
    assert.strictEqual(c("mods/a.jar").policy, "managed");
    assert.strictEqual(c("config/cobblemon/x.json").policy, "managed");
    assert.strictEqual(c("config/xaerominimap/s.txt").policy, "default");
    assert.strictEqual(c("options.txt").policy, "default");
    assert.strictEqual(c("saves/w/level.dat").policy, "preserved");
    assert.strictEqual(c("MODS/B.JAR").policy, "managed", "insensible à la casse");
    assert.strictEqual(c("mods/x.jar.disabled").policy, "preserved");
    assert.strictEqual(c("config/sub/debug.log").policy, "preserved");
    assert.strictEqual(c("options.txt/../x").policy !== "preserved", true);
    assert.strictEqual(c("inconnu.bin").matched, null);
});

test("Fichiers PERSONNELS : jamais publiés (preserved) ou jamais écrasés (default) ; les vrais réglages du modpack restent managed", () => {
    const rules = publish.compileRules(policy);
    const c = (p) => publish.classify(p, rules, "default").policy;

    /* données d'un joueur précis ou caches : jamais publiés */
    for (const p of ["config/impactor/economy/accounts/users/1e/1e2d3c4b-5a69-4788-9a0b-c1d2e3f40516.conf", "config/worldedit/sessions/a9b8c7d6-e5f4-4a3b-8c2d-1e0f9a8b7c6d.json",
        "config/voicechat/username-cache.json", "config/academy/gym_caches.json", "fancymenu_data/last_world.fmdata",
        "config/corgilib/announcement_store.json", "config/MythsAndLegends/cooldowns.json", "config/MythsAndLegends/debts.json", "config/resourceful-config-web.json"]) assert.strictEqual(c(p), "preserved", p);
    assert.strictEqual(c("config/MythsAndLegends/config.toml"), "managed", "la vraie configuration du mod reste gérée");

    /* réglages du joueur (côté client) : copiés une fois, jamais écrasés */
    for (const p of ["config/voicechat/voicechat-volumes.properties", "config/exposure-client.toml", "config/mod/sub/x_client.json", "config/mod/client.json",
        "config/fzzy_config/keybinds.toml", "config/defaultoptions/keybindings.txt", "config/xaerominimap/settings.txt"]) assert.strictEqual(c(p), "default", p);

    /* fichiers générés ou propres au joueur, hors config/ */
    assert.strictEqual(c("lootables_uses.json"), "preserved");
    assert.strictEqual(c("data/fabricDefaultResourcePacks.dat"), "preserved");
    for (const p of ["cobblenav/settings/pokenav.json", "cobblemon/riding_perspectives.json", "emi.json", "polymer/resource_pack.zip"]) assert.strictEqual(c(p), "default", p);

    /* le reste du modpack reste aligné sur le serveur (y compris showdown/ et codex/, qui sont du contenu du modpack) */
    for (const p of ["showdown/config/custom-formats.js", "codex/data.zip", "config/cobblemon/main.json", "config/impactor/impactor.conf", "mods/a.jar", "resourcepacks/p.zip", "datapacks/d/pack.mcmeta"]) assert.strictEqual(c(p), "managed", p);
});

test("Un motif sans '/' ne vaut qu'à la racine", () => {
    const rules = publish.compileRules(policy);
    assert.strictEqual(publish.classify("config/options.txt", rules, "x").policy, "managed");
});

/* ---------------- construction du manifest ---------------- */

test("Manifest v2 : contenu, catégories, préservés non publiés", async () => {
    const src = makeSource("src1");
    const { manifest, newAssets, stats, warnings } = await build(src, "1.0.0", path.join(tmp, "m-vide"));

    assert.strictEqual(manifest.schema, 2);
    assert.strictEqual(manifest.version, "1.0.0");
    assert.strictEqual(manifest.minecraft, "1.21.1");
    assert.strictEqual(manifest.java, 21);
    assert.deepStrictEqual(manifest.strictDirs, ["mods"]);
    assert.ok(manifest.remove.includes("mods/architectury-13.0.8-fabric.jar"), "liste remove reprise de policy.json");
    assert.ok(manifest.remove.every((p) => publish.validateRelPath(p) === null));

    const byPath = Object.fromEntries(manifest.files.map((f) => [f.path, f]));
    assert.deepStrictEqual(Object.keys(byPath).sort(), [
        "config/cobblemon/main.json", "config/xaerominimap/settings.txt", "inconnu.bin", "mods/alpha.jar",
        "mods/beta.jar", "options.txt", "resourcepacks/pack.zip", "servers.dat"
    ]);
    assert.strictEqual(byPath["mods/alpha.jar"].policy, "managed");
    assert.strictEqual(byPath["options.txt"].policy, "default");
    assert.strictEqual(byPath["mods/alpha.jar"].sha256, sha("alpha-v1"));
    assert.strictEqual(byPath["mods/alpha.jar"].size, 8);
    assert.strictEqual(stats.preserved, 4);          // vieux.jar.disabled, saves, screenshots, logs
    assert.ok(!JSON.stringify(manifest).includes("level.dat"));
    assert.ok(warnings.some((w) => w.includes("inconnu.bin")), "avertissement fichier sans règle");

    const url = byPath["mods/alpha.jar"].url;
    assert.ok(url.startsWith("https://github.com/cyrian290606/CobbleRealm-Pack/releases/download/pack-files-1/"));
    assert.ok(url.endsWith(`${sha("alpha-v1")}.jar`));
    assert.strictEqual(newAssets.length, 8);
    assert.deepStrictEqual(publish.validateManifest(manifest), []);
});

test(".properties : le manifest porte le hash du contenu utile (nsha256), pas les autres fichiers", async () => {
    const { normalizedPropertiesHash } = require("../updater/util");
    const text = "#Mod\n#Tue Oct 27 20:41:51 CET 2026\nb=2\na=1\n";
    const src = makeSource("src-props", { "config/mod.properties": text });
    const { manifest } = await build(src, "1.0.0", path.join(tmp, "m-vide"));
    const byPath = Object.fromEntries(manifest.files.map((f) => [f.path, f]));
    assert.strictEqual(byPath["config/mod.properties"].nsha256, normalizedPropertiesHash(Buffer.from(text)));
    assert.strictEqual(byPath["config/mod.properties"].sha256, sha(text));
    assert.strictEqual(byPath["mods/alpha.jar"].nsha256, undefined);
    assert.deepStrictEqual(publish.validateManifest(manifest), []);
    // la date seule ne change pas le hash utile ; une valeur oui
    assert.strictEqual(normalizedPropertiesHash(Buffer.from("#x\n#Sun Nov 08 21:53:03 CET 2026\na=1\nb=2\n")), byPath["config/mod.properties"].nsha256);
    assert.notStrictEqual(normalizedPropertiesHash(Buffer.from("#x\na=1\nb=3\n")), byPath["config/mod.properties"].nsha256);
});

test("Dédoublonnage : deux fichiers identiques = un seul envoi", async () => {
    const src = makeSource("src-dup", { "mods/copie.jar": "alpha-v1" });
    const { manifest, newAssets } = await build(src, "1.0.0", path.join(tmp, "m-vide"));
    assert.strictEqual(manifest.files.length, 9);
    assert.strictEqual(newAssets.length, 8);
});

test("Mise à jour : seuls les fichiers modifiés/ajoutés sont à envoyer", async () => {
    const archives = path.join(tmp, "m-archives");
    const v1 = await build(makeSource("src-v1"), "1.0.0", archives);
    write(archives, "manifest-1.0.0.json", JSON.stringify(v1.manifest));

    const v2src = makeSource("src-v2", {
        "mods/alpha.jar": "alpha-v2",       // modifié
        "mods/gamma.jar": "gamma-v1",      // ajouté
        "mods/beta.jar": null              // retiré
    });
    const v2 = await build(v2src, "1.1.0", archives);

    assert.deepStrictEqual(v2.newAssets.map((a) => a.assetName).sort(),
        [`${sha("alpha-v2")}.jar`, `${sha("gamma-v1")}.jar`].sort());
    assert.ok(v2.newAssets.every((a) => a.tag === "pack-files-1"), "la release ouverte reçoit les nouveaux fichiers");

    // un fichier inchangé garde l'URL de la version 1.0.0
    const options = v2.manifest.files.find((f) => f.path === "options.txt");
    assert.ok(options.url.includes("/pack-files-1/"));

    const changes = publish.summarizeChanges(v1.manifest, v2.manifest);
    assert.deepStrictEqual([changes.added, changes.changed, changes.removed], [1, 1, 1]);
    assert.strictEqual(changes.downloadBytes, "alpha-v2".length + "gamma-v1".length);
    assert.ok(!v2.manifest.files.some((f) => f.path === "mods/beta.jar"));

    // --no-reuse : tout est renvoyé
    const noReuse = await build(v2src, "1.1.0", archives, { reuse: false });
    assert.strictEqual(noReuse.newAssets.length, 8);
});

test("Plus de 900 fichiers : répartition en plusieurs releases", async () => {
    const small = { ...policy, hosting: { ...policy.hosting, maxAssetsPerRelease: 2 } };
    const result = await publish.buildManifest({
        sourceDir: makeSource("src-chunk"), policy: small, version: "2.0.0", manifestsDir: path.join(tmp, "m-vide"), bundles: false
    });
    const tags = [...new Set(result.newAssets.map((a) => a.tag))];
    assert.deepStrictEqual(tags, ["pack-files-1", "pack-files-2", "pack-files-3", "pack-files-4"]);
    assert.ok(result.newAssets.every((a) => result.newAssets.filter((b) => b.tag === a.tag).length <= 2));
});

test("Canal beta : tags dédiés", async () => {
    const r = await build(makeSource("src-beta"), "3.0.0", path.join(tmp, "m-vide"), { channel: "beta" });
    assert.ok(r.newAssets.every((a) => a.tag === "pack-beta-files-1"));
});

/* ---------------- validation ---------------- */

test("Validation : tous les cas de refus", async () => {
    const { manifest } = await build(makeSource("src-val"), "1.0.0", path.join(tmp, "m-vide"));
    const clone = () => JSON.parse(JSON.stringify(manifest));
    const refuse = (mutate, fragment) => {
        const m = clone();
        mutate(m);
        const errors = publish.validateManifest(m);
        assert.ok(errors.some((e) => e.includes(fragment)), `attendu '${fragment}', obtenu ${JSON.stringify(errors)}`);
    };

    refuse((m) => { m.files.push({ ...m.files[0], path: m.files[0].path.toUpperCase() }); }, "doublon");
    refuse((m) => { m.files[0].path = "../evasion.jar"; }, "'..'");
    refuse((m) => { m.files[0].path = "/abs.jar"; }, "absolu");
    refuse((m) => { m.files[0].url = ""; }, "URL manquante");
    refuse((m) => { m.files[0].url = "http://github.com/a/releases/download/t/f"; }, "https");
    refuse((m) => { m.files[0].url = "https://evil.example.com/releases/download/t/f"; }, "domaine non autorisé");
    refuse((m) => { m.files[0].sha256 = "xyz"; }, "sha256");
    refuse((m) => { m.files[0].policy = "preserved"; }, "catégorie");
    refuse((m) => { m.version = "1.0"; }, "version invalide");
    refuse((m) => { m.files = m.files.filter((f) => !f.path.startsWith("mods/")); }, "mode strict");
    refuse((m) => { m.remove = ["../evasion.dll"]; }, "remove");
    refuse((m) => { m.remove = ["mods/alpha.jar"]; }, "aussi publié");

    const m = clone();
    m.files = m.files.filter((f) => !f.path.startsWith("mods/"));
    assert.deepStrictEqual(publish.validateManifest(m, { allowEmptyMods: true }), []);
});

test("Vérification des URL : détecte une URL en 404", async () => {
    const { manifest } = await build(makeSource("src-url"), "1.0.0", path.join(tmp, "m-vide"));
    const missing = manifest.files[0].url;
    const fakeFetch = async (url) => ({ status: url === missing ? 404 : 206, body: null });
    const failures = await publish.checkUrls(manifest, fakeFetch);
    assert.strictEqual(failures.length, 1);
    assert.ok(failures[0].includes("404"));
    assert.deepStrictEqual(await publish.checkUrls(manifest, async () => ({ status: 200, body: null })), []);
});

/* ---------------- ligne de commande de bout en bout ---------------- */

test("CLI : publication, archive, 2e version, refus d'une version modifiée", () => {
    const root = path.join(tmp, "faux-depot");
    fs.mkdirSync(root, { recursive: true });
    const env = { ...process.env, PUBLISH_REPO_ROOT: root };
    const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, "..", "tools", "publish.js"), ...args],
        { env, encoding: "utf8" });

    const src = makeSource("src-cli");
    const out = path.join(tmp, "sortie");

    let r = cli(src, "--version", "1.0.0", "--out", out, "--no-bundles");
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.ok(fs.existsSync(path.join(out, "docs", "manifest.json")));
    assert.ok(fs.existsSync(path.join(out, "UPLOAD.md")));
    assert.strictEqual(fs.readdirSync(path.join(out, "release-pack-files-1")).length, 8);
    assert.ok(fs.existsSync(path.join(root, "manifests", "manifest-1.0.0.json")), "manifest archivé");
    assert.ok(!fs.existsSync(path.join(src, "docs")), "le dossier source n'est pas modifié");

    // 2e version : un mod modifié
    const src2 = makeSource("src-cli2", { "mods/alpha.jar": "alpha-v2" });
    r = cli(src2, "--version", "1.1.0", "--out", out, "--no-bundles");
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(fs.readdirSync(path.join(out, "release-pack-files-1")).length, 1);
    assert.ok(/Un joueur à jour téléchargera/.test(r.stdout));
    assert.ok(fs.existsSync(path.join(root, "manifests", "manifest-1.0.0.json")), "ancien manifest conservé");

    // même version, contenu différent : refus
    const src3 = makeSource("src-cli3", { "mods/alpha.jar": "alpha-v3" });
    r = cli(src3, "--version", "1.1.0", "--out", out);
    assert.strictEqual(r.status, 1);
    assert.ok(/existe déjà/.test(r.stderr));

    // sortie dans le dossier source : refus
    r = cli(src, "--version", "1.2.0", "--out", path.join(src, "sortie"));
    assert.strictEqual(r.status, 2);

    // dossier sans mods : refus
    const sansMods = makeSource("src-sans-mods", { "mods/alpha.jar": null, "mods/beta.jar": null });
    r = cli(sansMods, "--version", "1.3.0", "--out", out);
    assert.strictEqual(r.status, 1);
    assert.ok(/mode strict/.test(r.stderr));

    // --dry-run n'écrit rien
    r = cli(src2, "--version", "1.4.0", "--out", path.join(tmp, "autre"), "--dry-run");
    assert.strictEqual(r.status, 0);
    assert.ok(!fs.existsSync(path.join(tmp, "autre")));
    assert.ok(!fs.existsSync(path.join(root, "manifests", "manifest-1.4.0.json")));
});

/* ---------------- exécution ---------------- */

(async () => {
    let failed = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`  OK    ${name}`); }
        catch (error) { failed++; console.log(`  ECHEC ${name}\n        ${String(error.message).split("\n").slice(0, 3).join("\n        ")}`); }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failed ? `\n${failed} test(s) en échec` : "\nTous les tests passent");
    process.exit(failed ? 1 : 0);
})();
