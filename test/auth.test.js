/*
 * Tests de auth.js (connexion Microsoft) avec un faux MSAL. Lancer avec : node test/auth.test.js
 * Aucun compte réel, aucun réseau.
 */

const assert = require("assert");
const Module = require("module");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- faux MSAL ---------- */

const state = {
    accounts: [],
    removed: [],
    requests: [],
    silentOk: false,
    behavior: "wait",          // wait | approve | expire
    ignoreCancel: false,       // simule MSAL qui a déjà obtenu le jeton au moment de l'annulation
    deviceCodeCalls: 0
};

class FakePCA {

    getTokenCache() {
        return {
            serialize: () => "{}",
            deserialize() {},
            getAllAccounts: async () => state.accounts.slice(),
            removeAccount: async (account) => {
                state.removed.push(account.username);
                state.accounts = state.accounts.filter((a) => a !== account);
            }
        };
    }

    async acquireTokenSilent() {
        if (!state.silentOk) throw new Error("silent impossible");
        return { accessToken: "silent-token" };
    }

    async acquireTokenByDeviceCode(request) {

        state.requests.push(request);
        state.deviceCodeCalls++;

        request.deviceCodeCallback({
            userCode: "AB12CD34",
            verificationUri: "https://microsoft.com/devicelogin",
            expiresIn: 900,
            message: "Va sur la page"
        });

        /* Attente simulée : MSAL relit request.cancel à chaque tour */
        for (;;) {
            await sleep(5);
            if (request.cancel && !state.ignoreCancel) throw Object.assign(new Error("Token request cancelled"), { errorCode: "device_code_polling_cancelled" });
            if (state.behavior === "expire") throw Object.assign(new Error("Device code expired"), { errorCode: "device_code_expired" });
            if (state.behavior === "approve") {
                const account = { username: "joueur@mail.com", homeAccountId: "h1" };
                state.accounts.push(account);
                return { accessToken: "new-token", account };
            }
        }
    }
}

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === "@azure/msal-node") return { PublicClientApplication: FakePCA };
    if (request === "electron") {
        return {
            app: { getPath: () => require("os").tmpdir() },
            safeStorage: { isEncryptionAvailable: () => false }
        };
    }
    return originalLoad.call(this, request, ...rest);
};

const auth = require("../auth");

const reset = () => {
    state.accounts = []; state.removed = []; state.requests = [];
    state.silentOk = false; state.behavior = "wait"; state.deviceCodeCalls = 0; state.ignoreCancel = false;
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("Connexion réussie : le code (avec sa durée de validité) est transmis, puis le compte", async () => {
    reset();
    const codes = [];
    const pending = auth.loginMicrosoft((c) => codes.push(c));
    await sleep(30);
    assert.strictEqual(codes.length, 1);
    assert.strictEqual(codes[0].userCode, "AB12CD34");
    assert.strictEqual(codes[0].expiresIn, 900);
    assert.strictEqual(codes[0].verificationUri, "https://microsoft.com/devicelogin");

    state.behavior = "approve";
    const result = await pending;
    assert.ok(result.success);
    assert.strictEqual(result.accessToken, "new-token");
    assert.strictEqual(result.account.username, "joueur@mail.com");
});

test("Session existante : connexion silencieuse, aucun code demandé", async () => {
    reset();
    state.accounts = [{ username: "joueur@mail.com", homeAccountId: "h1" }];
    state.silentOk = true;
    const result = await auth.loginMicrosoft(() => assert.fail("pas de code attendu"));
    assert.ok(result.success && result.silent);
    assert.strictEqual(state.deviceCodeCalls, 0);
});

test("Annulation : le joueur est libéré immédiatement, MSAL est arrêté, nouvelle connexion possible", async () => {
    reset();
    const pending = auth.loginMicrosoft(() => {});
    await sleep(30);

    const started = Date.now();
    assert.strictEqual(auth.cancelLogin(), true);
    const result = await pending;

    assert.ok(Date.now() - started < 100, "réponse immédiate");
    assert.deepStrictEqual([result.success, result.code], [false, "MICROSOFT_CANCELLED"]);
    assert.strictEqual(state.requests[0].cancel, true, "l'attente de MSAL est arrêtée");
    assert.strictEqual(auth.cancelLogin(), false, "plus rien à annuler");

    // un nouvel essai fonctionne tout de suite
    state.behavior = "approve";
    const again = await auth.loginMicrosoft(() => {});
    assert.ok(again.success);
    assert.strictEqual(state.deviceCodeCalls, 2);
});

test("Validation tardive après annulation : rien n'est conservé", async () => {
    reset();
    const pending = auth.loginMicrosoft(() => {});
    await sleep(30);
    auth.cancelLogin();
    await pending;
    state.behavior = "approve";           // le joueur valide quand même dans son navigateur
    await sleep(50);
    assert.deepStrictEqual(state.accounts, [], "le compte est oublié");
    assert.deepStrictEqual(state.removed, []);   // (jamais ajouté : la requête annulée s'est arrêtée avant)
});

test("Annulation au dernier instant (jeton déjà obtenu par MSAL) : le compte est oublié, jamais enregistré", async () => {
    reset();
    state.ignoreCancel = true;
    const pending = auth.loginMicrosoft(() => {});
    await sleep(30);
    auth.cancelLogin();
    state.behavior = "approve";
    await sleep(60);
    assert.deepStrictEqual(state.accounts, [], "le compte ne reste pas en mémoire");
    assert.ok(state.removed.includes("joueur@mail.com"));
    assert.strictEqual((await pending).code, "MICROSOFT_CANCELLED");
});

test("Code expiré : code d'erreur précis", async () => {
    reset();
    state.behavior = "expire";
    const result = await auth.loginMicrosoft(() => {});
    assert.deepStrictEqual([result.success, result.code], [false, "MICROSOFT_EXPIRED"]);
});

test("Deux connexions simultanées : une seule demande de code, même résultat pour tous", async () => {
    reset();
    const first = auth.loginMicrosoft(() => {});
    const second = auth.loginMicrosoft(() => assert.fail("le 2e appelant ne reçoit pas un 2e code"));
    await sleep(30);
    state.behavior = "approve";
    const [a, b] = await Promise.all([first, second]);
    assert.strictEqual(a, b);
    assert.ok(a.success);
    assert.strictEqual(state.deviceCodeCalls, 1);
});

test("Déconnexion : annule une connexion en cours et oublie le compte", async () => {
    reset();
    state.accounts = [{ username: "joueur@mail.com", homeAccountId: "h1" }];
    const pending = auth.loginMicrosoft(() => {});   // session silencieuse refusée -> code demandé
    await sleep(30);
    const out = await auth.logoutMicrosoft();
    const result = await pending;
    assert.ok(out.success);
    assert.deepStrictEqual([result.success, result.code], [false, "MICROSOFT_CANCELLED"]);
    assert.deepStrictEqual(state.accounts, []);
    assert.ok(state.removed.includes("joueur@mail.com"));
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
