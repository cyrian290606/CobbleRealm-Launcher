/*
 * Tests de la mise à jour du launcher lui-même (launcherUpdates.js) avec un faux electron-updater.
 * Lancer avec : node test/launcherupdates.test.js
 */

const assert = require("assert");
const Module = require("module");
const path = require("path");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function makeFakeUpdater() {
    const handlers = {};
    return {
        calls: [],
        autoDownload: undefined, autoInstallOnAppQuit: undefined, allowPrerelease: undefined,
        handlers,
        on(event, fn) { handlers[event] = fn; },
        checkForUpdates() { this.calls.push("check"); return this.failCheck ? Promise.reject(new Error("réseau coupé")) : Promise.resolve(); },
        quitAndInstall(...args) { this.calls.push(["quitAndInstall", ...args]); }
    };
}

/* electron-updater est chargé À L'APPEL de initLauncherUpdates : le faux module reste donc actif pendant tout le test. */
let current = null;
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === "electron-updater") {
        if (current === "absent") throw new Error("introuvable");
        return { autoUpdater: current };
    }
    return originalLoad.call(this, request, ...rest);
};

function load(fake) {
    current = fake;
    return require("../launcherUpdates");
}

const logs = { warn: [] };
const log = { warn: (...a) => logs.warn.push(a.join(" ")) };

test("En développement (application non empaquetée) : rien ne se passe", () => {
    const fake = makeFakeUpdater();
    const { initLauncherUpdates } = load(fake);
    assert.strictEqual(initLauncherUpdates({ app: { isPackaged: false }, notify() {}, log }), null);
    assert.deepStrictEqual(fake.calls, []);
});

test("Application installée : téléchargement automatique, jamais de pré-version, installation à la fermeture, vérification au démarrage", () => {
    const fake = makeFakeUpdater();
    const { initLauncherUpdates } = load(fake);
    const result = initLauncherUpdates({ app: { isPackaged: true }, notify() {}, log });
    assert.ok(result && typeof result.installNow === "function");
    assert.strictEqual(fake.autoDownload, true);
    assert.strictEqual(fake.autoInstallOnAppQuit, true);
    assert.strictEqual(fake.allowPrerelease, false, "les pre-releases sont ignorées");
    assert.deepStrictEqual(fake.calls, ["check"]);
});

test("Les événements deviennent « en cours de téléchargement » puis « prête » pour l'interface", () => {
    const fake = makeFakeUpdater();
    const { initLauncherUpdates } = load(fake);
    const events = [];
    initLauncherUpdates({ app: { isPackaged: true }, notify: (e) => events.push(e), log });
    fake.handlers["update-available"]({ version: "2.0.1" });
    fake.handlers["update-downloaded"]({ version: "2.0.1" });
    assert.deepStrictEqual(events, [{ state: "downloading", version: "2.0.1" }, { state: "ready", version: "2.0.1" }]);
});

test("« Redémarrer maintenant » : installation SILENCIEUSE avec relance automatique (pas d'assistant d'installation à cliquer)", () => {
    const fake = makeFakeUpdater();
    const { initLauncherUpdates } = load(fake);
    const result = initLauncherUpdates({ app: { isPackaged: true }, notify() {}, log });
    result.installNow();
    assert.deepStrictEqual(fake.calls.pop(), ["quitAndInstall", true, true]);
});

test("Pas de réseau, pas de release, serveur en panne : aucune erreur visible pour le joueur, le modpack reste utilisable", async () => {
    const fake = makeFakeUpdater();
    fake.failCheck = true;
    const { initLauncherUpdates } = load(fake);
    const events = [];
    assert.doesNotThrow(() => initLauncherUpdates({ app: { isPackaged: true }, notify: (e) => events.push(e), log }));
    await new Promise((r) => setTimeout(r, 20));          // la promesse rejetée est absorbée (pas d'exception non gérée)
    fake.handlers.error(new Error("Cannot find latest.yml in the latest release artifacts"));
    assert.deepStrictEqual(events, [], "rien n'est affiché au joueur");
    assert.ok(logs.warn.some((l) => /latest\.yml/.test(l)), "mais l'erreur est journalisée");
});

test("Un module electron-updater absent n'empêche jamais le launcher de démarrer", () => {
    current = "absent";
    const { initLauncherUpdates } = require("../launcherUpdates");
    assert.strictEqual(initLauncherUpdates({ app: { isPackaged: true }, notify() {}, log }), null);
});

(async () => {
    let failed = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`  OK    ${name}`); }
        catch (error) { failed++; console.log(`  ECHEC ${name}\n        ${String(error.stack || error).split("\n").slice(0, 4).join("\n        ")}`); }
    }
    console.log(failed ? `\n${failed} test(s) en échec` : "\nTous les tests passent");
    process.exit(failed ? 1 : 0);
})();
