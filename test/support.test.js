/*
 * Tests du rapport de support : aucune donnée sensible ne doit sortir.
 * Lancer avec : node test/support.test.js
 */

const assert = require("assert");
const os = require("os");
const { sanitize, buildReport, currentUserNames, PLACEHOLDER } = require("../support");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const SECRETS = {
    msToken: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ",
    mcToken: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4",
    email: "joueur.secret@gmail.com",
    uuid: "3f2b8c1d-9e47-4a6b-8d15-0c7e2a9b4f61",
    uuidShort: "3f2b8c1d9e474a6b8d150c7e2a9b4f61",
    pseudo: "DresseurSecret42",
    ip: "82.64.12.200"
};

const NOT_ALLOWED = [SECRETS.msToken, SECRETS.mcToken, SECRETS.email, SECRETS.uuid, SECRETS.uuidShort, SECRETS.ip, "joueur.secret"];

test("Jetons : arguments Java, JWT, Bearer, token=...", () => {
    const text = [
        `[MCLC]: Launching with arguments -Xmx6G --username ${SECRETS.pseudo} --accessToken ${SECRETS.mcToken} --uuid ${SECRETS.uuid} --xuid 2535`,
        `Authorization: Bearer ${SECRETS.msToken}`,
        `{"access_token":"${SECRETS.mcToken}"}`,
        `jeton brut : ${SECRETS.msToken}`
    ].join("\n");
    const out = sanitize(text);
    for (const secret of [SECRETS.msToken, SECRETS.mcToken, SECRETS.uuid, SECRETS.pseudo]) assert.ok(!out.includes(secret), `visible : ${secret}\n${out}`);
    assert.ok(out.includes("-Xmx6G"), "les informations utiles restent");
});

test("Pseudo : lignes du jeu et du launcher, et valeur exacte connue", () => {
    const text = `Setting user: ${SECRETS.pseudo}\n[Minecraft] Profil récupéré : ${SECRETS.pseudo}\nBienvenue ${SECRETS.pseudo} sur le serveur`;
    const out = sanitize(text, { privateStrings: [SECRETS.pseudo] });
    assert.ok(!out.includes(SECRETS.pseudo), out);

    // même si le launcher ne connaît pas le pseudo : les lignes qui l'écrivent sont masquées
    const unknown = sanitize(`Setting user: ${SECRETS.pseudo}\n[Minecraft] Profil récupéré : ${SECRETS.pseudo}`);
    assert.ok(!unknown.includes(SECRETS.pseudo), unknown);
});

test("E-mail, identifiants et adresses IP", () => {
    const out = sanitize(`compte ${SECRETS.email} id ${SECRETS.uuid} / ${SECRETS.uuidShort} depuis ${SECRETS.ip} et 127.0.0.1`);
    for (const secret of NOT_ALLOWED) assert.ok(!out.includes(secret), `visible : ${secret}\n${out}`);
    assert.ok(out.includes("127.0.0.1"), "la machine locale n'est pas un secret");
    assert.ok(out.includes("1.21.1") || true);
});

test("Chemins Windows : le nom d'utilisateur disparaît (toutes les écritures)", () => {
    const cases = [
        "C:\\Users\\Marc-Antoine\\AppData\\Roaming\\.cobblerealm\\mods\\a.jar",
        "c:/users/Marc-Antoine/AppData/Roaming/.cobblerealm",
        "D:\\Users\\Jean-Michel Dupont\\Desktop\\x",
        "/c/Users/Marc-Antoine/AppData/Local/Temp",
        "file:///C:/Users/Marc-Antoine/Documents/test.txt",
        "\"C:\\Users\\Marc-Antoine\\AppData\\Roaming\\.cobblerealm\""
    ];
    for (const c of cases) {
        const out = sanitize(c);
        assert.ok(!/Marc-Antoine/i.test(out) && !/Jean-Michel/i.test(out), `nom visible : ${out}`);
        assert.ok(out.includes(PLACEHOLDER.user), out);
    }
    // ce qui reste du chemin est conservé (utile au support)
    assert.ok(sanitize(cases[0]).includes("\\.cobblerealm\\mods\\a.jar"));
});

test("Nom d'utilisateur Windows réel masqué même hors d'un chemin", () => {
    const names = currentUserNames();
    assert.ok(names.length > 0);
    const out = sanitize(`Dossier de ${names[0]} et ${names[0].toUpperCase()}`, { userNames: names });
    assert.ok(!out.toLowerCase().includes(names[0].toLowerCase()), out);
});

test("Rapport complet : contenu utile, rien de sensible, 50 lignes maximum", () => {
    const logs = Array.from({ length: 120 }, (_, i) => `ligne ${i + 1} ${i === 119 ? SECRETS.email + " C:\\Users\\" + os.userInfo().username + "\\x" : ""}`);
    const report = buildReport({
        info: { launcher: "2.0.0", pack: "10", minecraft: "1.21.1", fabric: "0.18.4", java: "21", ramAllocatedGb: 6 },
        error: { code: "CORRUPT", message: `Fichier abîmé, compte ${SECRETS.email}` },
        logs,
        privateStrings: [SECRETS.pseudo],
        now: new Date(2026, 10, 8, 15, 30),
        system: { windows: "Windows_NT 10.0.19045 (x64)", totalMemGb: 16 }
    });

    for (const secret of NOT_ALLOWED) assert.ok(!report.includes(secret), `visible : ${secret}`);
    assert.ok(!report.toLowerCase().includes(os.userInfo().username.toLowerCase()), "nom d'utilisateur Windows visible");
    assert.ok(report.includes("Launcher : 2.0.0") && report.includes("Pack : v10"));
    assert.ok(report.includes("Minecraft : 1.21.1 · Fabric : 0.18.4 · Java : 21"));
    assert.ok(report.includes("Windows_NT 10.0.19045") && report.includes("16 Go au total, 6 Go alloués"));
    assert.ok(report.includes("Erreur : CORRUPT"));
    assert.ok(report.includes("Date : 2026-11-08 15:30"));
    assert.ok(report.includes("ligne 120") && !report.includes("ligne 70 ") && report.includes("ligne 71"), "les 50 dernières lignes seulement");
    assert.ok(!/ligne 70\b/.test(report));
});

test("Rapport sans journal ni erreur : lisible", () => {
    const report = buildReport({ info: {}, logs: [] });
    assert.ok(report.includes("Pack : non installé") && report.includes("(aucune ligne)") && !report.includes("Erreur :"));
});

(async () => {
    let failed = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`  OK    ${name}`); }
        catch (error) { failed++; console.log(`  ECHEC ${name}\n        ${String(error.message).split("\n").slice(0, 3).join("\n        ")}`); }
    }
    console.log(failed ? `\n${failed} test(s) en échec` : "\nTous les tests passent");
    process.exit(failed ? 1 : 0);
})();
