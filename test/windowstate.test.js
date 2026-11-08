/*
 * Tests de la mémorisation de la fenêtre. Lancer avec : node test/windowstate.test.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { sanitizeState, readState, writeState, restoreBounds } = require("../windowState");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const screen1080 = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const screenLeft = { workArea: { x: -1920, y: 0, width: 1920, height: 1040 } };
const laptop = { workArea: { x: 0, y: 0, width: 1366, height: 728 } };

test("Premier lancement : taille par défaut, centrée", () => {
    assert.deepStrictEqual(restoreBounds(null, [screen1080]), { width: 1200, height: 700, maximized: false });
    assert.deepStrictEqual(restoreBounds(null, []), { width: 1200, height: 700, maximized: false });
});

test("Taille et position mémorisées retrouvées telles quelles", () => {
    const saved = sanitizeState({ x: 300, y: 120, width: 1400, height: 800, maximized: false });
    assert.deepStrictEqual(restoreBounds(saved, [screen1080]), { width: 1400, height: 800, x: 300, y: 120, maximized: false });
});

test("Fenêtre maximisée mémorisée", () => {
    const saved = sanitizeState({ x: 10, y: 10, width: 1300, height: 760, maximized: true });
    assert.strictEqual(restoreBounds(saved, [screen1080]).maximized, true);
});

test("Écran débranché : une position devenue invisible est abandonnée (fenêtre recentrée), la taille est gardée", () => {
    const saved = sanitizeState({ x: -1700, y: 100, width: 1200, height: 700 });     // sur l'écran de gauche
    const withBoth = restoreBounds(saved, [screen1080, screenLeft]);
    assert.strictEqual(withBoth.x, -1700, "écran présent : position conservée");

    const unplugged = restoreBounds(saved, [screen1080]);
    assert.strictEqual(unplugged.x, undefined);
    assert.strictEqual(unplugged.y, undefined);
    assert.deepStrictEqual([unplugged.width, unplugged.height], [1200, 700]);
});

test("Position totalement hors écran ou à peine visible : recentrée", () => {
    for (const [x, y] of [[99999 % 30000, 5000], [5000, 100], [1900, 100], [100, 1030], [-1190, 100]]) {
        const saved = sanitizeState({ x, y, width: 1200, height: 700 });
        const r = restoreBounds(saved, [screen1080]);
        assert.strictEqual(r.x, undefined, `(${x}, ${y}) devrait être recentré`);
    }
    // bien visible : conservée
    assert.strictEqual(restoreBounds(sanitizeState({ x: 1000, y: 100, width: 1200, height: 700 }), [screen1080]).x, 1000);
});

test("Écran plus petit qu'avant : la fenêtre est réduite pour tenir, sans passer sous la taille minimale", () => {
    const saved = sanitizeState({ x: 0, y: 0, width: 2400, height: 1300 });
    const r = restoreBounds(saved, [laptop]);
    assert.deepStrictEqual([r.width, r.height], [1366, 728]);
    const tiny = restoreBounds(sanitizeState({ x: 0, y: 0, width: 1000, height: 700 }), [{ workArea: { x: 0, y: 0, width: 800, height: 500 } }]);
    assert.deepStrictEqual([tiny.width, tiny.height], [900, 600], "jamais sous 900×600");
});

test("Contenu abîmé ou hostile : ignoré, jamais d'erreur", () => {
    for (const bad of [null, undefined, 42, "texte", [], {}, { width: 100, height: 100 }, { width: 1200, height: 5 }, { width: "x", height: "y" },
        { width: 1e12, height: 700 }, { width: NaN, height: 700 }, { width: Infinity, height: 700 }]) {
        assert.strictEqual(sanitizeState(bad), null, JSON.stringify(bad));
    }
    // une position absurde est ignorée mais la taille est gardée
    const s = sanitizeState({ x: 1e9, y: -1e9, width: 1200, height: 700 });
    assert.deepStrictEqual(s, { width: 1200, height: 700, maximized: false });
    assert.strictEqual(sanitizeState({ width: 1200, height: 700, maximized: "oui" }).maximized, false);
});

test("Fichier : écriture, relecture, fichier illisible ou absent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-ws-"));
    const file = path.join(dir, "sous", "window-state.json");
    try {
        assert.strictEqual(readState(file), null, "absent");
        assert.strictEqual(writeState(file, { x: 5, y: 6, width: 1300, height: 800, maximized: true }), true);
        assert.deepStrictEqual(readState(file), { x: 5, y: 6, width: 1300, height: 800, maximized: true });
        assert.strictEqual(writeState(file, { width: 10, height: 10 }), false, "état invalide jamais écrit");
        assert.deepStrictEqual(readState(file).width, 1300, "l'ancien état reste");
        fs.writeFileSync(file, "{pas du json");
        assert.strictEqual(readState(file), null, "abîmé");
        assert.ok(!fs.existsSync(`${file}.tmp`));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

(async () => {
    let failed = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`  OK    ${name}`); }
        catch (error) { failed++; console.log(`  ECHEC ${name}\n        ${String(error.stack || error).split("\n").slice(0, 3).join("\n        ")}`); }
    }
    console.log(failed ? `\n${failed} test(s) en échec` : "\nTous les tests passent");
    process.exit(failed ? 1 : 0);
})();
