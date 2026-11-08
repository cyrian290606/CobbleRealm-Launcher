/*
 * Tests automatiques de la phase 1 (sans Electron, sans compte Microsoft,
 * sans réseau). Lancer avec : node test/phase1.test.js
 *
 * Le vrai main.js est chargé avec des faux modules : electron, auth,
 * minecraftAuth et minecraft-launcher-core.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { EventEmitter } = require("events");

const SECRET_MS = "eyJhbGciOi.payloadpayload.signaturesig";
const SECRET_MC = "mc-token-ultra-secret";

/* ---------- environnement temporaire ---------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cr-test-"));
const appData = path.join(tmp, "appdata");
const userData = path.join(tmp, "userdata");
fs.mkdirSync(userData, { recursive: true });

const root = path.join(appData, ".cobblerealm");
const profileId = "fabric-loader-0.18.4-1.21.1";
fs.mkdirSync(path.join(root, "runtime", "java21", "bin"), { recursive: true });
fs.writeFileSync(path.join(root, "runtime", "java21", "bin", "java.exe"), "");
fs.mkdirSync(path.join(root, "versions", profileId), { recursive: true });
fs.writeFileSync(
    path.join(root, "versions", profileId, `${profileId}.json`),
    JSON.stringify({
        id: profileId,
        inheritsFrom: "1.21.1",
        mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
        libraries: []
    })
);

/* ---------- faux modules ---------- */

const ipc = {};
const opened = [];
let launchBehavior = "ok";
const launchedOptions = [];

class FakeClient extends EventEmitter {
    async launch(options) {
        launchedOptions.push(options);
        this.emit("debug", `[MCLC]: Launching with arguments -Xmx6G --accessToken ${SECRET_MC} --uuid 1`);
        this.emit("data", "Setting user: Bob");
        this.emit("progress", { type: "assets", task: 1, total: 2 });
        return launchBehavior === "null" ? null : { pid: 1 };
    }
}

const fakes = {
    electron: {
        app: {
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
        loginMicrosoft: async (cb) => {
            if (cb) {
                await cb({ userCode: "ABC123", verificationUri: "https://microsoft.com/devicelogin", message: "m" });
            }
            return { success: true, accessToken: SECRET_MS };
        },
        getMicrosoftSession: async () => ({}),
        logoutMicrosoft: async () => ({})
    },
    "./minecraftAuth": {
        loginMinecraft: async () => ({
            success: true,
            accessToken: SECRET_MC,
            profile: { id: "uuid-1", name: "Bob" }
        })
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
    console[level] = (...args) => {
        consoleOutput.push(args.map(String).join(" "));
    };
    console[`_${level}`] = original;
}

/* Faux fetch pour le manifest */
let manifestFetches = 0;
let manifestShouldFail = false;
global.fetch = async (url) => {
    if (String(url).includes("manifest.json")) {
        manifestFetches++;
        if (manifestShouldFail) {
            return { ok: false, status: 503, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => ({ version: "10", downloads: [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
};

const mainModule = require("../main.js");
const sender = () => {
    const sent = [];
    return {
        sent,
        send: (channel, payload) => sent.push({ channel, payload }),
        isDestroyed: () => false
    };
};

/* ---------- mini-framework ---------- */

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const client = () => {
    // le Client unique est celui créé par main.js
    return fakes["minecraft-launcher-core"].__instance;
};
FakeClient.prototype.constructor = FakeClient;
const instances = [];
const OriginalClient = fakes["minecraft-launcher-core"].Client;
fakes["minecraft-launcher-core"].Client = class extends OriginalClient {
    constructor() { super(); instances.push(this); }
};
// main.js a déjà été chargé avec l'ancienne référence : on récupère donc
// l'instance via un balayage des écouteurs au premier lancement.
let theClient = null;
const events = ["debug", "data", "progress", "close"];
const counts = () => Object.fromEntries(events.map((e) => [e, theClient.listenerCount(e)]));

const limits = (() => {
    const totalGb = os.totalmem() / 1024 ** 3;
    const maxRam = Math.max(2, Math.min(16, Math.floor(totalGb - 2)));
    return { maxRam, defaultRam: Math.min(maxRam, totalGb >= 16 ? 6 : 4) };
})();

/* ---------- les tests ---------- */

test("RAM : limites et défaut selon la mémoire de la machine", async () => {
    const s = await ipc["get-launcher-settings"]({});
    assert.strictEqual(s.maxRam, limits.maxRam);
    assert.strictEqual(s.defaultRam, limits.defaultRam);
    assert.strictEqual(s.ram, limits.defaultRam, "défaut sans fichier de paramètres");
    assert.ok(s.maxRam <= os.totalmem() / 1024 ** 3 - 2 + 1e-9 || s.maxRam === 2);
});

test("RAM : une valeur trop grande ou trop petite est ramenée dans la limite", async () => {
    let r = await ipc["save-launcher-settings"]({}, { ram: 99 });
    assert.strictEqual(r.ram, limits.maxRam);
    r = await ipc["save-launcher-settings"]({}, { ram: 1 });
    assert.strictEqual(r.ram, 2);
    // un vieux fichier avec 16 Go est plafonné à la lecture
    fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ ram: 16 }));
    const s = await ipc["get-launcher-settings"]({});
    assert.strictEqual(s.ram, Math.min(16, limits.maxRam));
    fs.rmSync(path.join(userData, "settings.json"));
});

test("Manifest : une seule requête pour plusieurs vérifications", async () => {
    manifestFetches = 0;
    const [a, b] = await Promise.all([
        ipc["check-cobblerealm-update"]({}),
        ipc["check-cobblerealm-update"]({})
    ]);
    await ipc["check-cobblerealm-update"]({});
    assert.ok(a.success && b.success);
    assert.strictEqual(manifestFetches, 1);
});

test("Lancement : code Microsoft envoyé puis fenêtre fermée, RAM plafonnée", async () => {
    const s = sender();
    launchedOptions.length = 0;
    const r = await ipc["launch-minecraft"]({ sender: s }, { ram: 99 });
    assert.ok(r.success, JSON.stringify(r));

    const codes = s.sent.filter((m) => m.channel === "microsoft-device-code");
    assert.strictEqual(codes.length, 2);
    assert.strictEqual(codes[0].payload.userCode, "ABC123");
    assert.strictEqual(codes[1].payload, null);
    assert.deepStrictEqual(opened, ["https://microsoft.com/devicelogin"]);

    assert.strictEqual(launchedOptions[0].memory.max, `${limits.maxRam}G`);
    assert.ok(launchedOptions[0].javaPath.endsWith("java.exe"));
});

test("Sécurité : aucun jeton dans l'interface ni dans la console", async () => {
    const s = sender();
    // fin de la session précédente
    theClient = theClient || findClient();
    theClient.emit("close", 0);
    const r = await ipc["launch-minecraft"]({ sender: s }, { ram: 4 });
    assert.ok(r.success);
    const logs = s.sent.filter((m) => m.channel === "minecraft-log").map((m) => m.payload).join("\n");
    assert.ok(logs.includes("--accessToken ***"), "jeton masqué dans l'interface");
    const all = logs + "\n" + consoleOutput.join("\n");
    for (const secret of [SECRET_MC, SECRET_MS]) {
        assert.ok(!all.includes(secret), "secret visible : " + secret);
    }
});

test("Écouteurs : retirés à la fermeture, pas de logs en double au 2e lancement", async () => {
    theClient.emit("close", 0);
    assert.deepStrictEqual(counts(), { debug: 0, data: 0, progress: 0, close: 0 });

    const s1 = sender();
    await ipc["launch-minecraft"]({ sender: s1 }, { ram: 4 });
    assert.deepStrictEqual(counts(), { debug: 1, data: 1, progress: 1, close: 1 });
    theClient.emit("close", 0);
    assert.deepStrictEqual(counts(), { debug: 0, data: 0, progress: 0, close: 0 });

    const s2 = sender();
    await ipc["launch-minecraft"]({ sender: s2 }, { ram: 4 });
    const settingUser = s2.sent.filter((m) => m.channel === "minecraft-log" && m.payload === "Setting user: Bob");
    assert.strictEqual(settingUser.length, 1, "chaque ligne arrive une seule fois");
    // l'ancien envoi (s1) ne reçoit plus rien du 2e lancement
    const s1Count = s1.sent.filter((m) => m.channel === "minecraft-log" && m.payload === "Setting user: Bob").length;
    assert.strictEqual(s1Count, 1);
    theClient.emit("close", 0);
});

test("Lancement simultané refusé", async () => {
    const s = sender();
    const first = await ipc["launch-minecraft"]({ sender: s }, { ram: 4 });
    assert.ok(first.success);
    const second = await ipc["launch-minecraft"]({ sender: sender() }, { ram: 4 });
    assert.strictEqual(second.success, false);
    assert.deepStrictEqual(counts(), { debug: 1, data: 1, progress: 1, close: 1 });
    theClient.emit("close", 0);
});

test("Échec de démarrage de MCLC : écouteurs retirés, nouveau lancement possible", async () => {
    launchBehavior = "null";
    const failed = await ipc["launch-minecraft"]({ sender: sender() }, { ram: 4 });
    assert.strictEqual(failed.success, false);
    assert.deepStrictEqual(counts(), { debug: 0, data: 0, progress: 0, close: 0 });
    launchBehavior = "ok";
    const ok = await ipc["launch-minecraft"]({ sender: sender() }, { ram: 4 });
    assert.ok(ok.success);
    theClient.emit("close", 0);
});

test("minecraft-test : le code Microsoft est aussi transmis", async () => {
    const s = sender();
    const r = await ipc["minecraft-test"]({ sender: s });
    assert.ok(r.success !== false, JSON.stringify(r));
    const codes = s.sent.filter((m) => m.channel === "microsoft-device-code");
    assert.strictEqual(codes[0].payload.userCode, "ABC123");
    assert.strictEqual(codes[codes.length - 1].payload, null);
});

test("Manifest : un échec n'est pas mis en cache", async () => {
    // main.js garde son cache de session : on le vérifie sur un module neuf
    const resolved = require.resolve("../main.js");
    delete require.cache[resolved];
    Object.keys(ipc).forEach((k) => delete ipc[k]);
    require("../main.js");
    manifestShouldFail = true;
    manifestFetches = 0;
    const bad = await ipc["check-cobblerealm-update"]({});
    assert.strictEqual(bad.success, false);
    manifestShouldFail = false;
    const good = await ipc["check-cobblerealm-update"]({});
    assert.ok(good.success);
    assert.strictEqual(manifestFetches, 2);
});

/* ---------- exécution ---------- */

function findClient() {
    // le Client de main.js est la seule instance FakeClient avec écouteurs
    return theClient;
}

(async () => {
    // On récupère l'instance de Client créée par main.js via le prototype.
    const originalLaunch = FakeClient.prototype.launch;
    FakeClient.prototype.launch = function (...args) {
        theClient = this;
        return originalLaunch.apply(this, args);
    };

    let failed = 0;
    for (const { name, fn } of tests) {
        try {
            await fn();
            console._log(`  OK    ${name}`);
        } catch (error) {
            failed++;
            console._log(`  ECHEC ${name}\n        ${error.message.split("\n")[0]}`);
        }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    console._log(failed ? `\n${failed} test(s) en échec` : "\nTous les tests passent");
    process.exit(failed ? 1 : 0);
})();
