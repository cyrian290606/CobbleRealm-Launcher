/*
 * Tests de runtime.js (Java) et fabric.js (phase 5). Lancer avec : node test/runtime.test.js
 * Serveurs locaux simulant Adoptium et Fabric : aucun accès réseau réel.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const { ensureJava, findJava, parseJavaVersion, managedJavaPath } = require("../runtime");
const { ensureFabricProfile, isProfileValid } = require("../fabric");
const { createTestServer } = require("../tools/test-server");

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/* Fabrique un vrai fichier ZIP (méthode « stocké »), sans dépendance. */
function makeZip(entries) {

    const locals = [], centrals = [];
    let offset = 0;

    for (const { name, data } of entries) {

        const nameBuf = Buffer.from(name);
        const crc = zlib.crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
        local.writeUInt16LE(0, 10); local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
        locals.push(local, nameBuf, data);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(33, 14);
        central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBuf);

        offset += 30 + nameBuf.length + data.length;
    }

    const centralBuf = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);

    return Buffer.concat([...locals, centralBuf, end]);
}

const JAVA_OK = 'openjdk version "21.0.13" 2026-10-21 LTS\nOpenJDK 64-Bit Server VM Temurin-21.0.13+9 (build 21.0.13+9-LTS, mixed mode)';

/* Faux « java -version » : le résultat dépend du chemin interrogé. */
const makeExec = (rules) => (file, args, options, callback) => {
    const text = rules(file);
    if (text === null) return callback(Object.assign(new Error("ENOENT"), { code: "ENOENT" }), "", "");
    callback(null, "", text);
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function withEnv(fn) {

    const srv = createTestServer();
    const base = await srv.listen();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-rt-"));
    const runtimeRoot = path.join(root, "runtime");

    try { await fn({ srv, base, root, runtimeRoot }); }
    finally { await srv.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }
}

/* Publie un faux Adoptium : API + archive ZIP contenant java.exe */
function serveJava(env, { checksum = null, link = null, version = JAVA_OK } = {}) {

    const zip = makeZip([
        { name: "jdk-21.0.13+9-jre/bin/java.exe", data: Buffer.from("MZ-faux-java") },
        { name: "jdk-21.0.13+9-jre/release", data: Buffer.from("JAVA_VERSION=21") }
    ]);

    env.srv.state.blobs.set("/jre.zip", zip);
    env.srv.state.blobs.set("/v3/assets/latest/21/hotspot", Buffer.from(JSON.stringify([{
        binary: { package: { name: "OpenJDK21U-jre_x64_windows_hotspot_21.0.13_9.zip", link: link || `${env.base}/jre.zip`, size: zip.length, checksum: checksum || sha(zip) } }
    }])));

    /* java.exe fraîchement extrait (dossier -temp) répond avec `version`, rien ailleurs */
    return makeExec((file) => (String(file).includes("java21-temp") || String(file).includes(`${path.sep}java21${path.sep}`)) ? version : null);
}

/* ---------------- analyse de version ---------------- */

test("Lecture de la version de Java", () => {
    assert.deepStrictEqual(parseJavaVersion(JAVA_OK), { major: 21, is64: true });
    assert.deepStrictEqual(parseJavaVersion('java version "1.8.0_301"\nJava HotSpot(TM) 64-Bit Server VM'), { major: 8, is64: true });
    assert.deepStrictEqual(parseJavaVersion('openjdk version "17.0.2"\nOpenJDK Client VM'), { major: 17, is64: false });
    assert.strictEqual(parseJavaVersion("n'importe quoi"), null);
});

/* ---------------- recherche d'un Java existant ---------------- */

test("Java existant >= 21 64 bits accepté ; trop ancien ou 32 bits refusé", () => withEnv(async ({ runtimeRoot }) => {
    const rules = (answers) => makeExec((file) => answers[file] === undefined ? null : answers[file]);

    assert.strictEqual(await findJava({ runtimeRoot, required: 21, env: {}, exec: rules({ java: JAVA_OK }) }), "java");
    assert.strictEqual(await findJava({ runtimeRoot, required: 21, env: {}, exec: rules({ java: 'openjdk version "17.0.2"\n64-Bit' }) }), null);
    assert.strictEqual(await findJava({ runtimeRoot, required: 21, env: {}, exec: rules({ java: 'openjdk version "21.0.1"\nClient VM' }) }), null);
    assert.strictEqual(await findJava({ runtimeRoot, required: 21, env: {}, exec: rules({}) }), null);
    assert.strictEqual(await findJava({ runtimeRoot, required: 25, env: {}, exec: rules({ java: JAVA_OK }) }), null, "Java 21 ne suffit pas pour 25");

    // le runtime CobbleRealm déjà installé est prioritaire
    const managed = managedJavaPath(runtimeRoot, 21);
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.writeFileSync(managed, "x");
    assert.strictEqual(await findJava({ runtimeRoot, required: 21, env: {}, exec: rules({ [managed]: JAVA_OK, java: JAVA_OK }) }), managed);
}));

/* ---------------- téléchargement ---------------- */

test("Aucun Java : téléchargement, vérification du hash, extraction, puis réutilisation sans réseau", () => withEnv(async (env) => {
    const exec = serveJava(env);
    const messages = [];

    const javaPath = await ensureJava({
        runtimeRoot: env.runtimeRoot, required: 21, apiBase: env.base, allowLocal: true, exec, env: {},
        onStatus: (m) => messages.push(m)
    });

    assert.strictEqual(javaPath, managedJavaPath(env.runtimeRoot, 21));
    assert.ok(fs.existsSync(javaPath));
    assert.ok(messages.some((m) => /Téléchargement de Java 21/.test(m)));
    assert.ok(!fs.existsSync(path.join(env.runtimeRoot, "java21-temp")), "dossier temporaire nettoyé");
    assert.ok(!fs.existsSync(path.join(env.runtimeRoot, ".download")), "archive téléchargée nettoyée");
    assert.ok(env.srv.state.requests.some((r) => r.path === "/v3/assets/latest/21/hotspot"));

    env.srv.state.requests.length = 0;
    const again = await ensureJava({ runtimeRoot: env.runtimeRoot, required: 21, apiBase: env.base, allowLocal: true, exec, env: {} });
    assert.strictEqual(again, javaPath);
    assert.strictEqual(env.srv.state.requests.length, 0, "deuxième appel : aucun accès réseau");
}));

test("Hash de l'archive incorrect : refus, rien d'installé", () => withEnv(async (env) => {
    const exec = serveJava(env, { checksum: "0".repeat(64) });

    await assert.rejects(
        ensureJava({ runtimeRoot: env.runtimeRoot, required: 21, apiBase: env.base, allowLocal: true, exec, env: {} }),
        (e) => e.code === "CORRUPT"
    );

    assert.ok(!fs.existsSync(managedJavaPath(env.runtimeRoot, 21)));
}));

test("Lien de téléchargement hors liste blanche : refusé", () => withEnv(async (env) => {
    const exec = serveJava(env, { link: "https://evil.example.com/jre.zip" });

    await assert.rejects(
        ensureJava({ runtimeRoot: env.runtimeRoot, required: 21, apiBase: env.base, allowLocal: true, exec, env: {} }),
        (e) => e.code === "FORBIDDEN_HOST"
    );
}));

test("Java téléchargé trop ancien ou défaillant : refusé, ancien runtime non cassé", () => withEnv(async (env) => {
    const exec = serveJava(env, { version: 'openjdk version "17.0.2"\n64-Bit' });

    await assert.rejects(
        ensureJava({ runtimeRoot: env.runtimeRoot, required: 21, apiBase: env.base, allowLocal: true, exec, env: {} }),
        /ne fonctionne pas/
    );

    assert.ok(!fs.existsSync(managedJavaPath(env.runtimeRoot, 21)));
}));

test("Serveur Adoptium injoignable : message clair en français", () => withEnv(async (env) => {
    await assert.rejects(
        ensureJava({ runtimeRoot: env.runtimeRoot, required: 21, apiBase: env.base, allowLocal: true, env: {}, exec: makeExec(() => null) }),
        /Impossible de télécharger Java 21\. Vérifie ta connexion/
    );
}));

/* ---------------- Fabric ---------------- */

const fabricProfile = (loader, mc) => ({ id: `autre-${loader}`, inheritsFrom: "x", mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient", libraries: [{ name: "a" }] });

test("Fabric : profil téléchargé selon les versions du manifest, régénéré si elles changent", () => withEnv(async (env) => {
    for (const [mc, loader] of [["1.21.1", "0.18.4"], ["1.21.4", "0.19.0"]]) {
        env.srv.state.blobs.set(`/v2/versions/loader/${mc}/${loader}/profile/json`, Buffer.from(JSON.stringify(fabricProfile(loader, mc))));
    }

    const opts = { root: env.root, metaBase: env.base, allowLocal: true };

    const id1 = await ensureFabricProfile({ ...opts, minecraft: "1.21.1", fabricLoader: "0.18.4" });
    assert.strictEqual(id1, "fabric-loader-0.18.4-1.21.1");
    assert.ok(isProfileValid(env.root, "1.21.1", "0.18.4"));
    const profile = JSON.parse(fs.readFileSync(path.join(env.root, "versions", id1, `${id1}.json`), "utf8"));
    assert.strictEqual(profile.id, id1);
    assert.strictEqual(profile.inheritsFrom, "1.21.1");

    // déjà valide : aucune requête
    env.srv.state.requests.length = 0;
    await ensureFabricProfile({ ...opts, minecraft: "1.21.1", fabricLoader: "0.18.4" });
    assert.strictEqual(env.srv.state.requests.length, 0);

    // le manifest change de version : nouveau profil, l'ancien reste en place
    const id2 = await ensureFabricProfile({ ...opts, minecraft: "1.21.4", fabricLoader: "0.19.0" });
    assert.strictEqual(id2, "fabric-loader-0.19.0-1.21.4");
    assert.strictEqual(env.srv.state.requests.length, 1);
    assert.ok(isProfileValid(env.root, "1.21.1", "0.18.4"));

    // profil local corrompu : régénéré
    fs.writeFileSync(path.join(env.root, "versions", id2, `${id2}.json`), "{pas du json");
    assert.ok(!isProfileValid(env.root, "1.21.4", "0.19.0"));
    await ensureFabricProfile({ ...opts, minecraft: "1.21.4", fabricLoader: "0.19.0" });
    assert.ok(isProfileValid(env.root, "1.21.4", "0.19.0"));
}));

test("Fabric : versions invalides ou inexistantes refusées avec un message clair", () => withEnv(async (env) => {
    const opts = { root: env.root, metaBase: env.base, allowLocal: true };

    await assert.rejects(ensureFabricProfile({ ...opts, minecraft: "../../x", fabricLoader: "0.18.4" }), /invalides/);
    await assert.rejects(ensureFabricProfile({ ...opts, minecraft: "1.99", fabricLoader: "0.18.4" }), /n'existe pas pour Minecraft 1\.99/);

    await env.srv.close();
    await assert.rejects(ensureFabricProfile({ ...opts, minecraft: "1.21.1", fabricLoader: "0.18.4" }), /Impossible de télécharger Fabric\. Vérifie ta connexion/);
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
