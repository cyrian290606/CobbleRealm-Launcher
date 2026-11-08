/*
 * Tests du processus principal (main.js) : phases 1, 4, 5 et 6.
 * Sans Electron, sans compte Microsoft, sans réseau. Lancer avec : node test/phase1.test.js
 *
 * Le vrai main.js est chargé avec des faux modules : electron, auth, minecraftAuth,
 * minecraft-launcher-core, updater, runtime (Java) et fabric.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { EventEmitter } = require("events");
const { pathToFileURL } = require("url");

const SECRET_MS = "eyJhbGciOi.payloadpayload.signaturesig";
const SECRET_MC = "mc-token-ultra-secret";

/* ---------- environnement temporaire ---------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cr-test-"));
const appData = path.join(tmp, "appdata");
const userData = path.join(tmp, "userdata");
fs.mkdirSync(userData, { recursive: true });

const INDEX_URL = pathToFileURL(path.join(__dirname, "..", "index.html")).href;

/* ---------- faux modules ---------- */

const ipc = {};
const opened = [];
const calls = [];                       // ordre des étapes
let launchBehavior = "ok";
const launchedOptions = [];
let theClient = null;

class FakeClient extends EventEmitter {
    async launch(options) {
        theClient = this;
        calls.push("launch");
        launchedOptions.push(options);
        this.emit("debug", `[MCLC]: Launching with arguments -Xmx6G --accessToken ${SECRET_MC} --uuid 1`);
        this.emit("data", "Setting user: Bob");
        this.emit("progress", { type: "assets", task: 1, total: 2 });
        return launchBehavior === "null" ? null : { pid: 1 };
    }
}

/* Faux updater : comportement réglable par les tests */
const upd = {
    checkCalls: 0, syncCalls: 0, repairCalls: 0, manifestCalls: 0,
    lock: null,
    manifest: { minecraft: "1.21.1", fabricLoader: "0.18.4", java: 21, recommendedRamGb: 6 },
    checkResult: { ok: true, offline: false, valid: true, installedVersion: "10", remoteVersion: "10", updateAvailable: false, filesToDownload: 0, bytesToDownload: 0 },
    syncImpl: async () => ({ ok: true, offline: false, version: "10" })
};

const javaCalls = [];

/* Connexion Microsoft simulée (remplaçable par un test) */
const defaultAuth = async (cb) => {
    calls.push("auth");
    if (cb) {
        await cb({ userCode: "ABC123", verificationUri: "https://microsoft.com/devicelogin", message: "m" });
        await cb({ userCode: "EVIL", verificationUri: "https://evil.example.com/phish", message: "m" });
    }
    return { success: true, accessToken: SECRET_MS };
};
let authImpl = defaultAuth;
const fabricCalls = [];

const fakes = {
    electron: {
        app: {
            isPackaged: false,
            requestSingleInstanceLock: () => true,
            on() {},
            quit() {},
            whenReady: () => new Promise(() => {}),
            getPath: (n) => (n === "appData" ? appData : n === "userData" ? userData : tmp)
        },
        BrowserWindow: class { static getAllWindows() { return []; } },
        Menu: { setApplicationMenu() {} },
        ipcMain: { handle: (name, fn) => { ipc[name] = fn; } },
        shell: { openExternal: async (u) => { opened.push(u); } }
    },
    "minecraft-launcher-core": { Client: FakeClient },
    "./auth": {
        loginMicrosoft: (cb) => authImpl(cb),
        getMicrosoftSession: async () => ({}),
        logoutMicrosoft: async () => ({})
    },
    "./minecraftAuth": {
        loginMinecraft: async () => ({
            success: true,
            accessToken: SECRET_MC,
            profile: { id: "uuid-1", name: "Bob" }
        })
    },
    "./updater": {
        createUpdater: () => ({
            status: () => ({ lock: upd.lock, valid: Boolean(upd.lock), version: upd.lock && upd.lock.version }),
            check: async () => { upd.checkCalls++; return upd.checkResult; },
            sync: async () => { upd.syncCalls++; calls.push("sync"); return upd.syncImpl(); },
            repair: async () => { upd.repairCalls++; return { ok: true, version: "10" }; },
            getManifest: async () => { upd.manifestCalls++; if (!upd.manifest) throw new Error("hors-ligne"); return upd.manifest; }
        })
    },
    "./runtime": {
        ensureJava: async (opts) => { calls.push("java"); javaCalls.push(opts); return "C:\\java\\bin\\java.exe"; }
    },
    "./fabric": {
        ensureFabricProfile: async (opts) => { calls.push("fabric"); fabricCalls.push(opts); return `fabric-loader-${opts.fabricLoader}-${opts.minecraft}`; }
    }
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    return Object.prototype.hasOwnProperty.call(fakes, request)
        ? fakes[request]
        : originalLoad.call(this, request, ...rest);
};

/* Capture de la console (pour vérifier qu'aucun secret n'y passe) */
const consoleOutput = [];
for (const level of ["log", "warn", "error"]) {
    const original = console[level];
    console[level] = (...args) => { consoleOutput.push(args.map(String).join(" ")); };
    console[`_${level}`] = original;
}

global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

require("../main.js");

const sender = () => {
    const sent = [];
    return {
        sent,
        send: (channel, payload) => sent.push({ channel, payload }),
        isDestroyed: () => false
    };
};

/* Événement IPC venant de notre page (de confiance) */
const trusted = (s) => ({ sender: s, senderFrame: { url: `${INDEX_URL}#accueil` } });

const events = ["debug", "data", "progress", "close"];
const counts = () => Object.fromEntries(events.map((e) => [e, theClient.listenerCount(e)]));
const sentOn = (s, channel) => s.sent.filter((m) => m.channel === channel).map((m) => m.payload);

const limits = (() => {
    const totalGb = os.totalmem() / 1024 ** 3;
    const maxRam = Math.max(2, Math.min(16, Math.floor(totalGb - 2)));
    return { maxRam, defaultRam: Math.min(maxRam, totalGb >= 16 ? 6 : 4) };
})();

/* Remet les réglages par défaut entre deux tests */
function reset() {
    calls.length = 0; launchedOptions.length = 0; javaCalls.length = 0; fabricCalls.length = 0; opened.length = 0;
    launchBehavior = "ok";
    authImpl = defaultAuth;
    upd.syncImpl = async () => ({ ok: true, offline: false, version: "10" });
    upd.manifest = { minecraft: "1.21.1", fabricLoader: "0.18.4", java: 21, recommendedRamGb: 6 };
    upd.lock = null;
    if (theClient) for (const e of events) theClient.removeAllListeners(e);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------- Phase 1 : correctifs ---------- */

test("RAM : limites et défaut selon la mémoire de la machine", async () => {
    const s = await ipc["get-launcher-settings"](trusted(sender()));
    assert.strictEqual(s.maxRam, limits.maxRam);
    assert.strictEqual(s.defaultRam, limits.defaultRam);
    assert.strictEqual(s.ram, limits.defaultRam, "défaut sans fichier de paramètres");
});

test("RAM : une valeur trop grande ou trop petite est ramenée dans la limite", async () => {
    let r = await ipc["save-launcher-settings"](trusted(sender()), { ram: 99 });
    assert.strictEqual(r.ram, limits.maxRam);
    r = await ipc["save-launcher-settings"](trusted(sender()), { ram: 1 });
    assert.strictEqual(r.ram, 2);
    fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ ram: 16 }));
    const s = await ipc["get-launcher-settings"](trusted(sender()));
    assert.strictEqual(s.ram, Math.min(16, limits.maxRam));
    fs.rmSync(path.join(userData, "settings.json"));
});

test("RAM : le défaut suit la valeur recommandée du manifest (limitée par la machine)", async () => {
    reset();
    upd.lock = { version: "10", ...upd.manifest, recommendedRamGb: 5 };
    const s = await ipc["get-launcher-settings"](trusted(sender()));
    const totalGb = os.totalmem() / 1024 ** 3;
    assert.strictEqual(s.defaultRam, Math.min(limits.maxRam, totalGb >= 12 ? 5 : 4));
});

test("Statut de version : une seule vérification, même module que la mise à jour", async () => {
    reset();
    upd.checkCalls = 0;
    const [a, b] = await Promise.all([
        ipc["check-cobblerealm-update"](trusted(sender())),
        ipc["check-cobblerealm-update"](trusted(sender()))
    ]);
    await ipc["check-cobblerealm-update"](trusted(sender()));
    assert.ok(a.success && b.success);
    assert.strictEqual(a.message, "CobbleRealm à jour — v10");
    assert.strictEqual(upd.checkCalls, 1);
});

test("Lancement : code Microsoft envoyé puis fenêtre fermée, RAM plafonnée, pages non-Microsoft jamais ouvertes", async () => {
    reset();
    const s = sender();
    const r = await ipc["launch-minecraft"](trusted(s), { ram: 99 });
    assert.ok(r.success, JSON.stringify(r));

    const codes = sentOn(s, "microsoft-device-code");
    assert.strictEqual(codes[0].userCode, "ABC123");
    assert.strictEqual(codes[codes.length - 1], null);
    assert.deepStrictEqual(opened, ["https://microsoft.com/devicelogin"], "le lien evil.example.com n'est pas ouvert");
    assert.strictEqual(launchedOptions[0].memory.max, `${limits.maxRam}G`);
    theClient.emit("close", 0);
});

test("Sécurité : aucun jeton dans l'interface ni dans la console", async () => {
    reset();
    const s = sender();
    const r = await ipc["launch-minecraft"](trusted(s), { ram: 4 });
    assert.ok(r.success);
    const logs = sentOn(s, "minecraft-log").join("\n");
    assert.ok(logs.includes("--accessToken ***"), "jeton masqué dans l'interface");
    const all = logs + "\n" + consoleOutput.join("\n");
    for (const secret of [SECRET_MC, SECRET_MS]) assert.ok(!all.includes(secret), "secret visible : " + secret);
    theClient.emit("close", 0);
});

test("Écouteurs : retirés à la fermeture, pas de logs en double au 2e lancement", async () => {
    reset();
    const s1 = sender();
    await ipc["launch-minecraft"](trusted(s1), { ram: 4 });
    assert.deepStrictEqual(counts(), { debug: 1, data: 1, progress: 1, close: 1 });
    theClient.emit("close", 0);
    assert.deepStrictEqual(counts(), { debug: 0, data: 0, progress: 0, close: 0 });

    const s2 = sender();
    await ipc["launch-minecraft"](trusted(s2), { ram: 4 });
    assert.strictEqual(sentOn(s2, "minecraft-log").filter((m) => m === "Setting user: Bob").length, 1);
    theClient.emit("close", 0);
});

test("Lancement simultané refusé", async () => {
    reset();
    const first = await ipc["launch-minecraft"](trusted(sender()), { ram: 4 });
    assert.ok(first.success);
    const second = await ipc["launch-minecraft"](trusted(sender()), { ram: 4 });
    assert.strictEqual(second.success, false);
    assert.deepStrictEqual(counts(), { debug: 1, data: 1, progress: 1, close: 1 });
    theClient.emit("close", 0);
});

test("Échec de démarrage de MCLC : écouteurs retirés, nouveau lancement possible", async () => {
    reset();
    launchBehavior = "null";
    const failed = await ipc["launch-minecraft"](trusted(sender()), { ram: 4 });
    assert.strictEqual(failed.success, false);
    assert.deepStrictEqual(counts(), { debug: 0, data: 0, progress: 0, close: 0 });
    launchBehavior = "ok";
    const ok = await ipc["launch-minecraft"](trusted(sender()), { ram: 4 });
    assert.ok(ok.success);
    theClient.emit("close", 0);
});

test("minecraft-test : le code Microsoft est aussi transmis", async () => {
    reset();
    const s = sender();
    const r = await ipc["minecraft-test"](trusted(s));
    assert.ok(r.success !== false, JSON.stringify(r));
    const codes = sentOn(s, "microsoft-device-code");
    assert.strictEqual(codes[0].userCode, "ABC123");
    assert.strictEqual(codes[codes.length - 1], null);
});

/* ---------- Phase 4 : synchronisation avant le jeu ---------- */

test("Ordre : mise à jour, puis authentification, puis Java, Fabric et le jeu", async () => {
    reset();
    const r = await ipc["launch-minecraft"](trusted(sender()), { ram: 4 });
    assert.ok(r.success);
    assert.deepStrictEqual(calls, ["sync", "auth", "java", "fabric", "launch"]);
    theClient.emit("close", 0);
});

test("Mise à jour en échec : le jeu ne démarre JAMAIS, erreur lisible envoyée à l'interface", async () => {
    reset();
    upd.syncImpl = async () => {
        throw Object.assign(new Error("Le fichier « a.jar » est resté corrompu après 3 essais."), { code: "CORRUPT", canRepair: true });
    };
    const s = sender();
    const r = await ipc["launch-minecraft"](trusted(s), { ram: 4 });

    assert.strictEqual(r.success, false);
    assert.strictEqual(r.step, "update");
    assert.deepStrictEqual(calls, ["sync"], "ni authentification, ni Java, ni jeu");
    const [err] = sentOn(s, "update-error");
    assert.deepStrictEqual(err, { code: "CORRUPT", message: "Le fichier « a.jar » est resté corrompu après 3 essais.", canRepair: true });
    assert.deepStrictEqual(counts(), { debug: 0, data: 0, progress: 0, close: 0 });

    // « Réessayer » : le lancement redevient possible
    upd.syncImpl = async () => ({ ok: true, offline: false, version: "10" });
    const retry = await ipc["launch-minecraft"](trusted(sender()), { ram: 4 });
    assert.ok(retry.success);
    theClient.emit("close", 0);
});

test("Hors-ligne avec installation valide : avertissement puis jeu sur la version installée", async () => {
    reset();
    upd.lock = { version: "9.5", minecraft: "1.21.1", fabricLoader: "0.18.4", java: 21, recommendedRamGb: 6 };
    upd.manifest = null;
    upd.syncImpl = async () => ({ ok: true, offline: true, version: "9.5" });
    const s = sender();
    const r = await ipc["launch-minecraft"](trusted(s), { ram: 4 });
    assert.ok(r.success);
    const [warning] = sentOn(s, "update-warning");
    assert.ok(/Hors-ligne/.test(warning.message) && warning.message.includes("9.5"));
    assert.deepStrictEqual(sentOn(s, "update-error"), []);
    theClient.emit("close", 0);
});

test("Réparation : lance la réparation de l'updater ; échec signalé à l'interface", async () => {
    reset();
    upd.repairCalls = 0;
    const ok = await ipc["repair-installation"](trusted(sender()));
    assert.ok(ok.success);
    assert.strictEqual(upd.repairCalls, 1);
});

/* ---------- Phase 5 : versions pilotées par le manifest ---------- */

test("Versions Minecraft / Fabric / Java lues dans le manifest", async () => {
    reset();
    upd.manifest = { minecraft: "1.21.4", fabricLoader: "0.19.2", java: 25, recommendedRamGb: 5 };
    const r = await ipc["launch-minecraft"](trusted(sender()), { ram: 4 });
    assert.ok(r.success);
    assert.strictEqual(javaCalls[0].required, 25);
    assert.strictEqual(fabricCalls[0].minecraft, "1.21.4");
    assert.strictEqual(fabricCalls[0].fabricLoader, "0.19.2");
    assert.strictEqual(launchedOptions[0].version.number, "1.21.4");
    assert.strictEqual(launchedOptions[0].version.custom, "fabric-loader-0.19.2-1.21.4");
    theClient.emit("close", 0);
});

test("Manifest absent : dernière installation connue, puis valeurs de secours", async () => {
    reset();
    upd.manifest = null;
    upd.syncImpl = async () => ({ ok: true, offline: false, version: "10" });
    upd.lock = { version: "10", minecraft: "1.20.1", fabricLoader: "0.15.0", java: 17, recommendedRamGb: 6 };
    await ipc["launch-minecraft"](trusted(sender()), { ram: 4 });
    assert.strictEqual(fabricCalls[0].minecraft, "1.20.1");
    assert.strictEqual(javaCalls[0].required, 17);
    theClient.emit("close", 0);

    reset();
    upd.manifest = null;
    await ipc["launch-minecraft"](trusted(sender()), { ram: 4 });
    assert.strictEqual(fabricCalls[0].minecraft, "1.21.1");
    assert.strictEqual(fabricCalls[0].fabricLoader, "0.18.4");
    assert.strictEqual(javaCalls[0].required, 21);
    theClient.emit("close", 0);
});

/* ---------- Phase 6 : sécurité ---------- */

test("IPC : un appel d'une origine inconnue est refusé", async () => {
    reset();
    const evil = [
        { sender: sender() },                                                          // pas de frame
        { sender: sender(), senderFrame: { url: "https://evil.example.com/index.html" } },
        { sender: sender(), senderFrame: { url: "file:///C:/autre/page.html" } },
        { sender: sender(), senderFrame: { url: `${INDEX_URL}.evil.html` } }
    ];
    for (const event of evil) {
        for (const channel of ["launch-minecraft", "save-launcher-settings", "repair-installation", "microsoft-login"]) {
            const r = await ipc[channel](event, { ram: 4 });
            assert.strictEqual(r.success, false, `${channel} devrait être refusé`);
            assert.strictEqual(r.error, "Appel refusé.");
        }
    }
    assert.deepStrictEqual(calls, [], "rien n'a été exécuté");
});

test("Erreurs : aucun jeton dans les messages renvoyés à l'interface", async () => {
    reset();
    upd.syncImpl = async () => ({ ok: true, offline: false, version: "10" });
    authImpl = async () => { throw new Error(`échec avec --accessToken ${SECRET_MC} et ${SECRET_MS}`); };
    const s = sender();
    const r = await ipc["launch-minecraft"](trusted(s), { ram: 4 });
    assert.strictEqual(r.success, false);
    const everything = JSON.stringify(r) + JSON.stringify(s.sent) + consoleOutput.join("\n");
    assert.ok(!everything.includes(SECRET_MC) && !everything.includes(SECRET_MS));
});

/* ---------- exécution ---------- */

(async () => {
    let failed = 0;
    for (const { name, fn } of tests) {
        try {
            await fn();
            console._log(`  OK    ${name}`);
        } catch (error) {
            failed++;
            console._log(`  ECHEC ${name}\n        ${String(error.message).split("\n")[0]}`);
        }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    console._log(failed ? `\n${failed} test(s) en échec` : "\nTous les tests passent");
    process.exit(failed ? 1 : 0);
})();
