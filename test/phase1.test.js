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
    syncImpl: async () => ({ ok: true, offline: false, version: "10" }),
    cancelCalls: 0,
    cancelResult: { cancelled: true }
};

const javaCalls = [];
const fakeWindows = [];
const openedPaths = [];
let openPathFailure = "";
const makeFakeWindow = (width, height) => {
    const win = { zoom: 1, size: [width, height], minimized: false, calls: [], isDestroyed: () => false, getContentSize: () => win.size, on() {},
        minimize() { win.minimized = true; win.calls.push("minimize"); }, restore() { win.minimized = false; win.calls.push("restore"); },
        isMinimized: () => win.minimized, show() { win.calls.push("show"); }, focus() { win.calls.push("focus"); },
        webContents: { send() {}, isDestroyed: () => false, getZoomFactor: () => win.zoom, setZoomFactor: (f) => { win.zoom = f; }, setVisualZoomLevelLimits: async () => {} } };
    return win;
};
let clipboardText = "";
let cancelCalls = 0;
let saveDialogChoice = { canceled: true };
const dialogCalls = [];
let logoutCalls = 0;
let javaFailure = null;
let fabricFailure = null;
let mcImpl = null;

/* Connexion Microsoft simulée (remplaçable par un test) */
const defaultAuth = async (cb) => {
    calls.push("auth");
    if (cb) {
        await cb({ userCode: "ABC123", verificationUri: "https://microsoft.com/devicelogin", message: "m" });
        await cb({ userCode: "EVIL", verificationUri: "https://evil.example.com/phish", message: "m" });
    }
    return { success: true, accessToken: SECRET_MS, account: { username: "joueur.secret@gmail.com" } };
};
let authImpl = defaultAuth;
const fabricCalls = [];

const fakes = {
    electron: {
        app: {
            isPackaged: false,
            getVersion: () => "2.0.0",
            requestSingleInstanceLock: () => true,
            on() {},
            quit() {},
            whenReady: () => new Promise(() => {}),
            getPath: (n) => (n === "appData" ? appData : n === "userData" ? userData : tmp)
        },
        BrowserWindow: class { static getAllWindows() { return fakeWindows; } },
        Menu: { setApplicationMenu() {} },
        ipcMain: { handle: (name, fn) => { ipc[name] = fn; } },
        shell: { openExternal: async (u) => { opened.push(u); }, openPath: async (p) => { openedPaths.push(p); return openPathFailure; } },
        clipboard: { writeText: (t) => { clipboardText = t; } },
        dialog: { showSaveDialog: async (win, options) => { dialogCalls.push(options); return saveDialogChoice; } }
    },
    "minecraft-launcher-core": { Client: FakeClient },
    "./auth": {
        loginMicrosoft: (cb) => authImpl(cb),
        getMicrosoftSession: async () => ({}),
        cancelLogin: () => { cancelCalls++; return true; },
        logoutMicrosoft: async () => { logoutCalls++; return { success: true }; }
    },
    "./minecraftAuth": {
        loginMinecraft: async (...args) => mcImpl ? mcImpl(...args) : ({
            success: true,
            accessToken: SECRET_MC,
            profile: { id: "3f2b8c1d-9e47-4a6b-8d15-0c7e2a9b4f61", name: "Bob" }
        })
    },
    "./updater": {
        createUpdater: () => ({
            status: () => ({ lock: upd.lock, valid: Boolean(upd.lock), version: upd.lock && upd.lock.version }),
            check: async () => { upd.checkCalls++; return upd.checkResult; },
            sync: async () => { upd.syncCalls++; calls.push("sync"); return upd.syncImpl(); },
            repair: async () => { upd.repairCalls++; return { ok: true, version: "10" }; },
            cancel: () => { upd.cancelCalls++; return upd.cancelResult; },
            getManifest: async () => { upd.manifestCalls++; if (!upd.manifest) throw new Error("hors-ligne"); return upd.manifest; }
        })
    },
    "./runtime": {
        ensureJava: async (opts) => { calls.push("java"); javaCalls.push(opts); if (javaFailure) throw javaFailure; return "C:\\java\\bin\\java.exe"; }
    },
    "./fabric": {
        ensureFabricProfile: async (opts) => { calls.push("fabric"); fabricCalls.push(opts); if (fabricFailure) throw fabricFailure; return `fabric-loader-${opts.fabricLoader}-${opts.minecraft}`; }
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
    cancelCalls = 0; logoutCalls = 0; mcImpl = null; javaFailure = null; fabricFailure = null; clipboardText = "";
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
    const [err] = sentOn(s, "launch-error");
    assert.deepStrictEqual(err, {
        code: "CORRUPT", title: "Mise à jour impossible",
        message: "Le fichier « a.jar » est resté corrompu après 3 essais.",
        actions: ["retry", "repair", "copy", "help"], canRepair: true, severity: "error"
    });
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
    assert.deepStrictEqual(sentOn(s, "launch-error"), []);
    theClient.emit("close", 0);
});

test("Réparation : lance la réparation de l'updater ; échec signalé à l'interface", async () => {
    reset();
    upd.repairCalls = 0;
    const ok = await ipc["repair-installation"](trusted(sender()));
    assert.ok(ok.success);
    assert.strictEqual(upd.repairCalls, 1);
});

/* ---------- Groupe 2 : erreurs lisibles ---------- */

const launchAndGetError = async (ram = 4) => {
    const s = sender();
    const r = await ipc["launch-minecraft"](trusted(s), { ram });
    const errors = sentOn(s, "launch-error");
    return { s, r, errors, error: errors[0] };
};

test("Erreur Microsoft annulée : message simple, seule action « Réessayer », rien d'autre exécuté", async () => {
    reset();
    authImpl = async () => { calls.push("auth"); return { success: false, error: "User cancelled the device code flow" }; };
    const { r, errors, error } = await launchAndGetError();
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(error.code, "MICROSOFT_CANCELLED");
    assert.strictEqual(error.title, "Connexion annulée");
    assert.deepStrictEqual(error.actions, ["retry"]);
    assert.strictEqual(r.step, "microsoft");
    assert.deepStrictEqual(calls, ["sync", "auth"], "ni Java ni jeu");
    assert.ok(!/device code|cancelled/i.test(error.message), "pas de jargon anglais");
});

test("Erreur Microsoft générale : pas de détail technique, proposition de changer de compte", async () => {
    reset();
    authImpl = async () => { calls.push("auth"); return { success: false, error: "AADSTS70000: interaction_required at https://login.microsoftonline.com/xyz" }; };
    const { error } = await launchAndGetError();
    assert.strictEqual(error.code, "MICROSOFT_FAILED");
    assert.ok(!/AADSTS|https?:|login\./.test(error.message), error.message);
    assert.ok(error.actions.includes("switchAccount") && error.actions.includes("copy") && error.actions.includes("help"));
});

test("Compte sans Minecraft Java : message précis, pas de « APPID », action « Changer de compte »", async () => {
    reset();
    mcImpl = async () => ({ success: false, status: null, error: "Ce compte ne semble pas posséder Minecraft Java Edition." });
    const { r, error } = await launchAndGetError();
    assert.strictEqual(error.code, "NO_MINECRAFT");
    assert.match(error.message, /ne possède pas Minecraft Java Edition/);
    assert.strictEqual(error.actions[0], "switchAccount");
    assert.strictEqual(r.step, "minecraft-auth");
    assert.deepStrictEqual(calls, ["sync", "auth"]);
    assert.ok(!/APPID/i.test(JSON.stringify(error)));
});

test("Services Minecraft : refus (403), trop de tentatives (429), réseau coupé", async () => {
    reset();
    mcImpl = async () => ({ success: false, status: 403, error: "Invalid app registration" });
    let e = (await launchAndGetError()).error;
    assert.strictEqual(e.code, "MINECRAFT_DENIED");
    assert.match(e.message, /code 403/);
    assert.ok(!/APPID|registration/i.test(e.message));

    reset();
    mcImpl = async () => ({ success: false, status: 429, error: "Too many requests" });
    e = (await launchAndGetError()).error;
    assert.strictEqual(e.code, "MINECRAFT_RATE_LIMIT");

    reset();
    mcImpl = async () => ({ success: false, status: null, error: "fetch failed ENOTFOUND api.minecraftservices.com" });
    e = (await launchAndGetError()).error;
    assert.strictEqual(e.code, "OFFLINE");
    assert.match(e.message, /Internet/);
    assert.ok(!/ENOTFOUND|api\./.test(e.message));
});

test("Java ou Fabric indisponible : message en français et jeu non lancé", async () => {
    reset();
    javaFailure = new Error("Impossible de télécharger Java 21. Vérifie ta connexion Internet puis réessaie.");
    let { r, error } = await launchAndGetError();
    assert.strictEqual(error.code, "JAVA_FAILED");
    assert.strictEqual(error.title, "Java indisponible");
    assert.match(error.message, /Java 21/);
    assert.strictEqual(r.step, "java");
    assert.ok(!calls.includes("launch") && !calls.includes("fabric"));

    reset();
    fabricFailure = new Error("TypeError: Cannot read properties of undefined (reading 'x') at C:\\Users\\Marc-Antoine\\app.asar");
    ({ r, error } = await launchAndGetError());
    assert.strictEqual(error.code, "FABRIC_FAILED");
    assert.ok(!/TypeError|Marc-Antoine|asar/.test(error.message), "aucun détail technique ni chemin : " + error.message);
    assert.strictEqual(r.step, "fabric");
});

test("Échec de démarrage de Minecraft : « Réparer l'installation » proposé", async () => {
    reset();
    launchBehavior = "null";
    const { error } = await launchAndGetError();
    assert.strictEqual(error.code, "LAUNCH_FAILED");
    assert.ok(error.actions.includes("repair") && error.canRepair);
});

test("Le jeu s'arrête avec une erreur (code ≠ 0) : le joueur est prévenu ; arrêt normal (0) : silence", async () => {
    reset();
    let s = sender();
    await ipc["launch-minecraft"](trusted(s), { ram: 4 });
    theClient.emit("close", 0);
    assert.deepStrictEqual(sentOn(s, "launch-error"), [], "fermeture normale");

    reset();
    s = sender();
    await ipc["launch-minecraft"](trusted(s), { ram: 4 });
    theClient.emit("close", 1);
    const [crash] = sentOn(s, "launch-error");
    assert.strictEqual(crash.code, "GAME_EXIT");
    assert.match(crash.message, /code 1/);
    assert.deepStrictEqual(counts(), { debug: 0, data: 0, progress: 0, close: 0 });

    // échec de démarrage de MCLC (close avec code 1 avant le lancement) : une seule erreur, celle du lancement
    reset();
    launchBehavior = "null";
    s = sender();
    const original = FakeClient.prototype.launch;
    FakeClient.prototype.launch = async function (options) { theClient = this; this.emit("close", 1); return null; };
    await ipc["launch-minecraft"](trusted(s), { ram: 4 });
    FakeClient.prototype.launch = original;
    const errors = sentOn(s, "launch-error");
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].code, "LAUNCH_FAILED");
});

test("Rapport de support : utile, mais sans jeton, e-mail, pseudo, identifiant ni nom d'utilisateur Windows", async () => {
    reset();
    mcImpl = async (token, onLog) => {
        onLog("[Minecraft] Profil récupéré : Bob");
        return { success: true, accessToken: SECRET_MC, profile: { id: "3f2b8c1d-9e47-4a6b-8d15-0c7e2a9b4f61", name: "Bob" } };
    };
    const userName = os.userInfo().username;
    const s = sender();
    await ipc["launch-minecraft"](trusted(s), { ram: 4 });
    theClient.emit("data", "Setting user: Bob");
    theClient.emit("data", "Chargement depuis C:\\Users\\" + userName + "\\AppData\\Roaming\\.cobblerealm\\mods");
    theClient.emit("data", "Compte joueur.secret@gmail.com connecté");
    theClient.emit("close", 1);

    const r = await ipc["copy-support-report"](trusted(sender()));
    assert.ok(r.success);

    for (const secret of [SECRET_MC, SECRET_MS, "Bob", "joueur.secret", "3f2b8c1d-9e47", userName]) {
        assert.ok(!clipboardText.toLowerCase().includes(secret.toLowerCase()), "visible dans le rapport : " + secret);
    }
    assert.match(clipboardText, /Launcher : 2\.0\.0/);
    assert.match(clipboardText, /Minecraft : 1\.21\.1/);
    assert.match(clipboardText, /Erreur : GAME_EXIT/);
    assert.match(clipboardText, /--accessToken <secret>/);
    assert.match(clipboardText, /\.cobblerealm/, "le chemin utile au support reste");
});

test("Message d'erreur affiché au joueur : jeton, e-mail et chemin personnel masqués même s'ils viennent d'un module", async () => {
    reset();
    const userName = os.userInfo().username;
    upd.syncImpl = async () => {
        throw Object.assign(
            new Error(`Fichier verrouillé : C:\\Users\\${userName}\\AppData\\Roaming\\.cobblerealm\\mods\\a.jar (compte joueur.secret@gmail.com, --accessToken ${SECRET_MC})`),
            { code: "FILE_LOCKED" }
        );
    };
    const { error } = await launchAndGetError();
    assert.strictEqual(error.code, "FILE_LOCKED");
    for (const secret of [userName, "joueur.secret", SECRET_MC]) {
        assert.ok(!error.message.toLowerCase().includes(secret.toLowerCase()), "visible dans le message : " + secret);
    }
    assert.match(error.message, /\.cobblerealm/, "le reste du message est conservé");
});

test("Rapport de support : le pseudo est masqué même quand il apparaît librement dans le journal", async () => {
    reset();
    await ipc["launch-minecraft"](trusted(sender()), { ram: 4 });
    theClient.emit("data", "[Chat] Bob a rejoint la partie");
    theClient.emit("close", 0);
    await ipc["copy-support-report"](trusted(sender()));
    assert.ok(!/bob/i.test(clipboardText), "pseudo visible : " + clipboardText.split("\n").find((l) => /bob/i.test(l)));
    assert.match(clipboardText, /rejoint la partie/, "le reste de la ligne est conservé");
});

test("Rapport de support : origine inconnue refusée", async () => {
    reset();
    clipboardText = "";
    const r = await ipc["copy-support-report"]({ sender: sender() });
    assert.strictEqual(r.success, false);
    assert.strictEqual(clipboardText, "");
});

/* ---------- Groupes 8 et 9 : réglages et zoom ---------- */

test("Réglages : valeurs inconnues ou abîmées remplacées par les valeurs par défaut", async () => {
    reset();
    const file = path.join(userData, "settings.json");
    const r = await ipc["save-launcher-settings"](trusted(sender()), { uiScale: 7, onLaunch: "explose", reduceMotion: 5, notifications: "oui" });
    assert.ok(r.success);
    assert.deepStrictEqual([r.uiScale, r.onLaunch, r.reduceMotion, r.notifications], ["auto", "keep", "auto", true]);

    // fichier illisible ou contenu hostile : jamais d'erreur, valeurs par défaut
    for (const content of ["{pas du json", "[]", "null", JSON.stringify({ uiScale: "<script>", onLaunch: { a: 1 }, ram: "beaucoup" })]) {
        fs.writeFileSync(file, content);
        const s = await ipc["get-launcher-settings"](trusted(sender()));
        assert.deepStrictEqual([s.uiScale, s.onLaunch, s.reduceMotion, s.notifications], ["auto", "keep", "auto", true], content);
        assert.ok(s.ram >= 2 && s.ram <= s.maxRam);
    }
    fs.rmSync(file, { force: true });
});

test("Réglages : valeurs valides conservées, fusion sans perte, origine inconnue refusée", async () => {
    reset();
    const file = path.join(userData, "settings.json");
    fs.rmSync(file, { force: true });
    await ipc["save-launcher-settings"](trusted(sender()), { ram: 3, uiScale: 1.25, onLaunch: "minimize", reduceMotion: "on", notifications: false });
    let s = await ipc["get-launcher-settings"](trusted(sender()));
    assert.deepStrictEqual([s.ram, s.uiScale, s.onLaunch, s.reduceMotion, s.notifications], [Math.min(3, limits.maxRam), 1.25, "minimize", "on", false]);

    // un changement partiel ne perd rien
    await ipc["save-launcher-settings"](trusted(sender()), { onLaunch: "keep" });
    s = await ipc["get-launcher-settings"](trusted(sender()));
    assert.deepStrictEqual([s.uiScale, s.onLaunch, s.reduceMotion, s.notifications], [1.25, "keep", "on", false]);

    // « fermer le launcher » n'est pas un choix valide (cela couperait les journaux du jeu)
    await ipc["save-launcher-settings"](trusted(sender()), { onLaunch: "close" });
    assert.strictEqual((await ipc["get-launcher-settings"](trusted(sender()))).onLaunch, "keep");

    // « 1.25 » écrit sous forme de texte est accepté, une échelle non prévue est refusée
    await ipc["save-launcher-settings"](trusted(sender()), { uiScale: "1.5" });
    assert.strictEqual((await ipc["get-launcher-settings"](trusted(sender()))).uiScale, 1.5);
    await ipc["save-launcher-settings"](trusted(sender()), { uiScale: 3 });
    assert.strictEqual((await ipc["get-launcher-settings"](trusted(sender()))).uiScale, "auto");

    const refused = await ipc["save-launcher-settings"]({ sender: sender() }, { onLaunch: "keep" });
    assert.strictEqual(refused.success, false);
    fs.rmSync(file, { force: true });
});

test("Zoom automatique : 100 % sur petit écran, grandit avec la fenêtre jusqu'à 150 %, réglage manuel prioritaire", async () => {
    reset();
    fs.rmSync(path.join(userData, "settings.json"), { force: true });
    const cases = [[1184, 661, 1], [1366, 728, 1], [1600, 880, 1.15], [1920, 1080, 1.4], [2560, 1380, 1.5], [3840, 2100, 1.5], [900, 560, 1]];
    for (const [w, h, expected] of cases) {
        fakeWindows.length = 0;
        const win = makeFakeWindow(w, h);
        fakeWindows.push(win);
        await ipc["save-launcher-settings"](trusted(sender()), { uiScale: "auto" });
        assert.strictEqual(win.zoom, expected, `${w}×${h}`);
    }
    // réglage manuel : prioritaire, quelle que soit la taille
    fakeWindows.length = 0;
    const win = makeFakeWindow(2560, 1380);
    fakeWindows.push(win);
    await ipc["save-launcher-settings"](trusted(sender()), { uiScale: 1.1 });
    assert.strictEqual(win.zoom, 1.1);
    await ipc["save-launcher-settings"](trusted(sender()), { uiScale: "auto" });
    assert.strictEqual(win.zoom, 1.5);
    fakeWindows.length = 0;
    fs.rmSync(path.join(userData, "settings.json"), { force: true });
});

/* ---------- Groupe 10 : console ---------- */

const fillJournal = async (secretUser) => {
    reset();
    mcImpl = async (token, onLog) => {
        onLog("[Minecraft] Profil récupéré : Bob");
        return { success: true, accessToken: SECRET_MC, profile: { id: "3f2b8c1d-9e47-4a6b-8d15-0c7e2a9b4f61", name: "Bob" } };
    };
    await ipc["launch-minecraft"](trusted(sender()), { ram: 4 });
    for (let i = 1; i <= 120; i++) theClient.emit("data", `ligne de jeu ${i}`);
    theClient.emit("data", "Compte joueur.secret@gmail.com chargé depuis C:\\Users\\" + secretUser + "\\AppData\\Roaming\\.cobblerealm");
    theClient.emit("data", "Setting user: Bob");
    theClient.emit("close", 0);
};

test("Console : « Copier » copie tout le journal horodaté, sans aucune donnée sensible", async () => {
    const user = os.userInfo().username;
    await fillJournal(user);
    const r = await ipc["copy-console"](trusted(sender()));
    assert.ok(r.success);
    assert.match(clipboardText, /=== Journal CobbleRealm ===/);
    assert.match(clipboardText, /^\[\d\d:\d\d:\d\d\] /m, "lignes horodatées");
    assert.ok(clipboardText.split("\n").length > 100, "bien plus que les 50 lignes d'un rapport d'erreur");
    assert.match(clipboardText, /ligne de jeu 1\b/);
    for (const secret of [SECRET_MC, SECRET_MS, "Bob", "joueur.secret", "3f2b8c1d-9e47", user]) {
        assert.ok(!clipboardText.toLowerCase().includes(secret.toLowerCase()), "visible : " + secret);
    }
    assert.match(clipboardText, /\.cobblerealm/, "le chemin utile reste");

    clipboardText = "";
    assert.strictEqual((await ipc["copy-console"]({ sender: sender() })).success, false);
    assert.strictEqual(clipboardText, "");
});

test("Console : « Exporter » écrit un fichier choisi par le joueur (sans donnée sensible) et ne renvoie que son nom", async () => {
    const user = os.userInfo().username;
    await fillJournal(user);
    const target = path.join(tmp, "export", "mon-journal.txt");
    fs.mkdirSync(path.dirname(target), { recursive: true });

    dialogCalls.length = 0;
    saveDialogChoice = { canceled: false, filePath: target };
    const r = await ipc["export-logs"](trusted(sender()));
    assert.deepStrictEqual([r.success, r.fileName], [true, "mon-journal.txt"]);
    assert.ok(!JSON.stringify(r).includes(path.dirname(target)), "aucun chemin renvoyé à la page");
    assert.match(dialogCalls[0].defaultPath, /^cobblerealm-journal-\d{8}-\d{4}\.txt$/);
    assert.deepStrictEqual(dialogCalls[0].filters[0].extensions, ["txt"]);

    const content = fs.readFileSync(target, "utf8");
    assert.match(content, /=== Journal CobbleRealm ===/);
    assert.ok(content.split("\n").length > 100);
    for (const secret of [SECRET_MC, SECRET_MS, "Bob", "joueur.secret", "3f2b8c1d-9e47", user]) {
        assert.ok(!content.toLowerCase().includes(secret.toLowerCase()), "visible dans le fichier : " + secret);
    }

    // annulation : aucun fichier, aucune erreur
    fs.rmSync(target);
    saveDialogChoice = { canceled: true };
    const cancelled = await ipc["export-logs"](trusted(sender()));
    assert.deepStrictEqual([cancelled.success, cancelled.cancelled], [false, true]);
    assert.ok(!fs.existsSync(target));

    // dossier impossible à écrire : message simple
    saveDialogChoice = { canceled: false, filePath: path.join(tmp, "n-existe-pas", "x.txt") };
    const failed = await ipc["export-logs"](trusted(sender()));
    assert.deepStrictEqual([failed.success, failed.error], [false, "Impossible d'enregistrer le fichier."]);

    dialogCalls.length = 0;
    assert.strictEqual((await ipc["export-logs"]({ sender: sender() })).success, false);
    assert.strictEqual(dialogCalls.length, 0, "origine inconnue : aucune boîte de dialogue");
    saveDialogChoice = { canceled: true };
});

test("Console : « Effacer » vide aussi le journal gardé par le launcher", async () => {
    await fillJournal("x");
    assert.ok((await ipc["clear-logs"](trusted(sender()))).success);
    await ipc["copy-console"](trusted(sender()));
    assert.match(clipboardText, /\(aucune ligne\)/);
    assert.ok(!/ligne de jeu/.test(clipboardText));
    clipboardText = "";
    assert.strictEqual((await ipc["clear-logs"]({ sender: sender() })).success, false);
});

/* ---------- Groupe 9 : paramètres ---------- */

test("Dossier du jeu : ouvre exactement le dossier du jeu (jamais une adresse venue de la page), le crée si besoin", async () => {
    reset();
    openedPaths.length = 0;
    const root = path.join(appData, ".cobblerealm");
    fs.rmSync(root, { recursive: true, force: true });

    const r = await ipc["open-game-folder"](trusted(sender()), "C:\\Windows\\System32");
    assert.ok(r.success);
    assert.deepStrictEqual(openedPaths, [root]);
    assert.ok(fs.existsSync(root), "dossier créé");

    openPathFailure = "Le chemin est introuvable";
    const failed = await ipc["open-game-folder"](trusted(sender()));
    assert.deepStrictEqual([failed.success, /Impossible/.test(failed.error)], [false, true]);
    assert.ok(!/introuvable/i.test(failed.error), "pas de détail système");
    openPathFailure = "";

    openedPaths.length = 0;
    const refused = await ipc["open-game-folder"]({ sender: sender() });
    assert.strictEqual(refused.success, false);
    assert.deepStrictEqual(openedPaths, []);
});

test("Pendant la partie : « Se réduire » minimise au lancement et revient à la fermeture du jeu ; « Rester ouvert » ne touche à rien", async () => {
    reset();
    fakeWindows.length = 0;
    const win = makeFakeWindow(1184, 661);
    fakeWindows.push(win);

    await ipc["save-launcher-settings"](trusted(sender()), { onLaunch: "keep" });
    await ipc["launch-minecraft"](trusted(sender()), { ram: 4 });
    theClient.emit("close", 0);
    assert.deepStrictEqual(win.calls, [], "rester ouvert : aucune action");

    await ipc["save-launcher-settings"](trusted(sender()), { onLaunch: "minimize" });
    await ipc["launch-minecraft"](trusted(sender()), { ram: 4 });
    assert.deepStrictEqual(win.calls, ["minimize"]);
    assert.strictEqual(win.minimized, true);
    theClient.emit("close", 0);
    assert.deepStrictEqual(win.calls, ["minimize", "restore", "show", "focus"], "le launcher revient à l'écran");

    // un arrêt avec erreur ramène aussi le launcher (pour afficher le message)
    win.calls.length = 0;
    await ipc["launch-minecraft"](trusted(sender()), { ram: 4 });
    theClient.emit("close", 1);
    assert.ok(win.calls.includes("restore"));

    // échec de démarrage : le launcher n'est jamais réduit
    win.calls.length = 0;
    launchBehavior = "null";
    await ipc["launch-minecraft"](trusted(sender()), { ram: 4 });
    assert.deepStrictEqual(win.calls, []);

    fakeWindows.length = 0;
    fs.rmSync(path.join(userData, "settings.json"), { force: true });
});

test("Infos de version : Java inclus pour la page « À propos »", async () => {
    reset();
    upd.manifest = { minecraft: "1.21.1", fabricLoader: "0.18.4", java: 21, recommendedRamGb: 6 };
    upd.lock = { version: "10", minecraft: "1.21.1", fabricLoader: "0.18.4", java: 21, recommendedRamGb: 6 };
    const info = await ipc["get-app-info"](trusted(sender()));
    assert.deepStrictEqual([info.launcher, info.pack, info.minecraft, info.fabric, info.java], ["2.0.0", "10", "1.21.1", "0.18.4", 21]);
    const s = await ipc["get-launcher-settings"](trusted(sender()));
    assert.strictEqual(s.recommendedRam, Math.min(s.maxRam, 6));
});

/* ---------- Groupe 3 : compte Microsoft ---------- */

test("Annuler la connexion : arrêt côté Microsoft et fenêtre du code fermée", async () => {
    reset();
    const s = sender();
    const r = await ipc["microsoft-cancel-login"](trusted(s));
    assert.ok(r.success);
    assert.strictEqual(cancelCalls, 1);
    const codes = sentOn(s, "microsoft-device-code");
    assert.strictEqual(codes[codes.length - 1], null);

    const refused = await ipc["microsoft-cancel-login"]({ sender: sender() });
    assert.strictEqual(refused.success, false);
    assert.strictEqual(cancelCalls, 1, "origine inconnue : refusé");
});

test("Rouvrir la page : seule l'adresse Microsoft du code en cours, jamais une adresse venue de la page", async () => {
    reset();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    authImpl = async (cb) => {
        calls.push("auth");
        await cb({ userCode: "ABCD1234", verificationUri: "https://microsoft.com/devicelogin", expiresIn: 900, message: "m" });
        await gate;
        return { success: true, accessToken: SECRET_MS, account: { username: "joueur.secret@gmail.com" } };
    };
    const pending = ipc["microsoft-login"](trusted(sender()));
    await new Promise((r) => setTimeout(r, 20));

    opened.length = 0;
    const r = await ipc["open-microsoft-login-page"](trusted(sender()), "https://evil.example.com/phish");
    assert.ok(r.success);
    assert.deepStrictEqual(opened, ["https://microsoft.com/devicelogin"]);

    release();
    const login = await pending;
    assert.ok(login.success);

    const afterwards = await ipc["open-microsoft-login-page"](trusted(sender()));
    assert.strictEqual(afterwards.success, false, "plus de connexion en cours");

    // un code dont la page n'est pas Microsoft n'est jamais rouvrable
    authImpl = async (cb) => {
        await cb({ userCode: "EVIL", verificationUri: "https://evil.example.com/x", expiresIn: 900, message: "m" });
        return { success: false, error: "x" };
    };
    await ipc["microsoft-login"](trusted(sender()));
    assert.strictEqual((await ipc["open-microsoft-login-page"](trusted(sender()))).success, false);
});

test("Copier le code : le code de la connexion en cours, jamais un texte venu de la page", async () => {
    reset();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    authImpl = async (cb) => {
        await cb({ userCode: "AB12CD34", verificationUri: "https://microsoft.com/devicelogin", expiresIn: 900, message: "m" });
        await gate;
        return { success: false, code: "MICROSOFT_CANCELLED", error: "x" };
    };
    const pending = ipc["microsoft-login"](trusted(sender()));
    await new Promise((r) => setTimeout(r, 20));

    clipboardText = "";
    const ok = await ipc["copy-login-code"](trusted(sender()), "TEXTE-ARBITRAIRE-DE-LA-PAGE");
    assert.ok(ok.success);
    assert.strictEqual(clipboardText, "AB12CD34");

    release();
    await pending;
    clipboardText = "";
    const after = await ipc["copy-login-code"](trusted(sender()));
    assert.strictEqual(after.success, false, "plus de connexion en cours");
    assert.strictEqual(clipboardText, "");

    const unknown = await ipc["copy-login-code"]({ sender: sender() });
    assert.strictEqual(unknown.success, false);

    // un code au format inattendu n'est jamais copiable
    authImpl = async (cb) => { await cb({ userCode: "A B; rm -rf /", verificationUri: "https://microsoft.com/devicelogin", expiresIn: 900, message: "m" }); return { success: false, error: "x" }; };
    await ipc["microsoft-login"](trusted(sender()));
    assert.strictEqual((await ipc["copy-login-code"](trusted(sender()))).success, false);
});

test("Le code Microsoft transmis à la page contient sa durée de validité", async () => {
    reset();
    const s = sender();
    authImpl = async (cb) => {
        await cb({ userCode: "ABCD1234", verificationUri: "https://microsoft.com/devicelogin", expiresIn: 900, message: "m" });
        return { success: true, accessToken: SECRET_MS };
    };
    await ipc["microsoft-login"](trusted(s));
    const [first] = sentOn(s, "microsoft-device-code");
    assert.strictEqual(first.expiresIn, 900);
});

test("Déconnexion : refusée pendant un lancement, autorisée ensuite ; origine inconnue refusée", async () => {
    reset();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    authImpl = async () => { calls.push("auth"); await gate; return { success: true, accessToken: SECRET_MS }; };

    const launching = ipc["launch-minecraft"](trusted(sender()), { ram: 4 });
    await new Promise((r) => setTimeout(r, 30));

    const refused = await ipc["microsoft-logout"](trusted(sender()));
    assert.strictEqual(refused.success, false);
    assert.match(refused.error, /pendant le lancement/);
    assert.strictEqual(logoutCalls, 0);

    release();
    await launching;
    theClient.emit("close", 0);

    const ok = await ipc["microsoft-logout"](trusted(sender()));
    assert.ok(ok.success);
    assert.strictEqual(logoutCalls, 1);

    const unknown = await ipc["microsoft-logout"]({ sender: sender() });
    assert.strictEqual(unknown.success, false);
    assert.strictEqual(logoutCalls, 1);
});

test("Connexion annulée pendant JOUER : message « Connexion annulée », rien d'autre exécuté", async () => {
    reset();
    authImpl = async () => { calls.push("auth"); return { success: false, code: "MICROSOFT_CANCELLED", error: "Connexion annulée." }; };
    const { r, error } = await launchAndGetError();
    assert.strictEqual(error.code, "MICROSOFT_CANCELLED");
    assert.deepStrictEqual(error.actions, ["retry"]);
    assert.deepStrictEqual(calls, ["sync", "auth"]);
});

/* ---------- Groupe 4 : annulation du téléchargement ---------- */

test("Annuler la mise à jour : demandé à l'updater, origine inconnue refusée", async () => {
    reset();
    upd.cancelCalls = 0;
    upd.cancelResult = { cancelled: true };
    const r = await ipc["cancel-update"](trusted(sender()));
    assert.ok(r.success && r.cancelled);
    assert.strictEqual(upd.cancelCalls, 1);

    upd.cancelResult = { cancelled: false, reason: "installing" };
    const late = await ipc["cancel-update"](trusted(sender()));
    assert.deepStrictEqual([late.success, late.cancelled, late.reason], [true, false, "installing"]);

    const refused = await ipc["cancel-update"]({ sender: sender() });
    assert.strictEqual(refused.success, false);
    assert.strictEqual(upd.cancelCalls, 2);
});

test("Mise à jour annulée par le joueur : simple information (pas une erreur rouge), le jeu ne démarre pas", async () => {
    reset();
    upd.syncImpl = async () => { throw Object.assign(new Error("Mise à jour annulée. Tu pourras la reprendre quand tu veux : les fichiers déjà téléchargés sont conservés."), { code: "CANCELLED" }); };
    const { r, error } = await launchAndGetError();
    assert.strictEqual(error.code, "UPDATE_CANCELLED");
    assert.strictEqual(error.severity, "info");
    assert.deepStrictEqual(error.actions, ["retry"]);
    assert.strictEqual(r.success, false);
    assert.deepStrictEqual(calls, ["sync"], "ni connexion ni jeu");
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
