const { PublicClientApplication } = require("@azure/msal-node");
const { app, safeStorage } = require("electron");

const fs = require("fs");
const path = require("path");

const CLIENT_ID = "da6df756-e672-4b00-86e1-d7fe5cdb5941";

const msalConfig = {
    auth: {
        clientId: CLIENT_ID,
        authority: "https://login.microsoftonline.com/consumers"
    }
};

const pca = new PublicClientApplication(msalConfig);


/* ==============================
   CHEMIN DU CACHE
============================== */

function getCachePath() {
    return path.join(
        app.getPath("userData"),
        "microsoft-session.dat"
    );
}


/* ==============================
   SAUVEGARDE DU CACHE
============================== */

function saveCache() {
    try {
        if (!safeStorage.isEncryptionAvailable()) {
            console.error(
                "Le chiffrement Windows n'est pas disponible."
            );

            return false;
        }

        const cache =
            pca.getTokenCache().serialize();

        const encrypted =
            safeStorage.encryptString(cache);

        fs.writeFileSync(
            getCachePath(),
            encrypted
        );

        return true;

    } catch (error) {
        console.error(
            "Erreur sauvegarde session Microsoft :",
            error
        );

        return false;
    }
}


/* ==============================
   CHARGEMENT DU CACHE
============================== */

function loadCache() {
    try {
        const cachePath =
            getCachePath();

        if (!fs.existsSync(cachePath)) {
            return false;
        }

        if (!safeStorage.isEncryptionAvailable()) {
            return false;
        }

        const encrypted =
            fs.readFileSync(cachePath);

        const decrypted =
            safeStorage.decryptString(
                encrypted
            );

        pca.getTokenCache()
            .deserialize(decrypted);

        return true;

    } catch (error) {
        console.error(
            "Erreur chargement session Microsoft :",
            error
        );

        return false;
    }
}


/* ==============================
   SESSION EXISTANTE
============================== */

async function getMicrosoftSession() {
    try {
        loadCache();

        const accounts =
            await pca.getTokenCache()
                .getAllAccounts();

        if (
            !accounts ||
            accounts.length === 0
        ) {
            return {
                success: false,
                connected: false
            };
        }

        const account =
            accounts[0];

        return {
            success: true,
            connected: true,

            account: {
                username:
                    account.username,

                homeAccountId:
                    account.homeAccountId
            }
        };

    } catch (error) {
        console.error(
            "Erreur récupération session :",
            error
        );

        return {
            success: false,
            connected: false,
            error: error.message
        };
    }
}


/* ==============================
   CONNEXION MICROSOFT
============================== */

const SCOPES = [
    "XboxLive.signin",
    "offline_access"
];

/*
 * Une seule connexion à la fois : si une connexion est déjà en cours (par exemple le joueur
 * clique sur JOUER pendant qu'un code est affiché), tout le monde partage la même.
 */
let loginInFlight = null;


function accountSummary(account) {

    return account
        ? {
            username: account.username,
            homeAccountId: account.homeAccountId
        }
        : null;
}


async function performLogin(
    onDeviceCode,
    entry
) {
    try {

        loadCache();

        const existingAccounts =
            await pca
                .getTokenCache()
                .getAllAccounts();

        if (
            existingAccounts &&
            existingAccounts.length > 0
        ) {
            const account =
                existingAccounts[0];

            try {
                const silentResponse =
                    await pca.acquireTokenSilent({
                        account: account,
                        scopes: SCOPES
                    });

                saveCache();

                return {
                    success: true,

                    silent: true,

                    accessToken:
                        silentResponse.accessToken,

                    account:
                        accountSummary(account)
                };

            } catch (silentError) {
                console.log(
                    "Session silencieuse expirée, nouvelle connexion requise."
                );
            }
        }


        /*
         * L'objet de requête est celui que MSAL lit à chaque tour d'attente :
         * mettre cancel à true arrête proprement l'attente du code.
         */
        const deviceCodeRequest = {

            scopes: SCOPES,

            cancel: false,

            deviceCodeCallback: (
                response
            ) => {

                if (onDeviceCode) {

                    onDeviceCode({
                        userCode:
                            response.userCode,

                        verificationUri:
                            response.verificationUri,

                        /* durée de validité du code, en secondes */
                        expiresIn:
                            response.expiresIn,

                        message:
                            response.message
                    });
                }
            }
        };

        entry.request = deviceCodeRequest;

        const response =
            await pca.acquireTokenByDeviceCode(
                deviceCodeRequest
            );

        if (entry.cancelled) {

            /* Annulé juste avant la validation : on n'enregistre rien. */
            await forgetAccounts();

            return {
                success: false,
                code: "MICROSOFT_CANCELLED",
                error: "Connexion annulée."
            };
        }

        if (!response) {
            throw new Error(
                "Microsoft n'a retourné aucune réponse."
            );
        }

        saveCache();

        return {
            success: true,

            silent: false,

            accessToken:
                response.accessToken,

            account:
                accountSummary(response.account)
        };

    } catch (error) {

        const errorCode =
            String(error && error.errorCode || "");

        let code;

        if (entry.cancelled || /cancel/i.test(errorCode)) {
            code = "MICROSOFT_CANCELLED";
        } else if (/expired|timeout/i.test(errorCode)) {
            code = "MICROSOFT_EXPIRED";
        }

        if (code !== "MICROSOFT_CANCELLED") {
            console.error(
                "Erreur pendant la connexion Microsoft :",
                errorCode,
                String(error && error.message).slice(0, 300)
            );
        }

        return {
            success: false,

            code,

            error:
                error.message ||
                "Erreur inconnue pendant la connexion Microsoft."
        };
    }
}


function loginMicrosoft(
    onDeviceCode
) {

    if (loginInFlight) {
        return loginInFlight.promise;
    }

    const entry = {
        cancelled: false,
        request: null,
        settle: null,
        promise: null
    };

    const cancelled = new Promise((resolve) => {
        entry.settle = resolve;
    });

    entry.promise =
        Promise.race([
            performLogin(onDeviceCode, entry),
            cancelled
        ]).finally(() => {

            if (loginInFlight === entry) {
                loginInFlight = null;
            }
        });

    loginInFlight = entry;

    return entry.promise;
}


/*
 * Annule la connexion en cours : le joueur est libéré tout de suite
 * (MSAL termine son attente en arrière-plan, sans rien enregistrer).
 */
function cancelLogin() {

    const entry = loginInFlight;

    if (!entry) {
        return false;
    }

    entry.cancelled = true;
    loginInFlight = null;

    if (entry.request) {
        entry.request.cancel = true;
    }

    entry.settle({
        success: false,
        code: "MICROSOFT_CANCELLED",
        error: "Connexion annulée."
    });

    return true;
}


async function forgetAccounts() {

    try {

        const accounts =
            await pca
                .getTokenCache()
                .getAllAccounts();

        for (const account of accounts) {
            await pca
                .getTokenCache()
                .removeAccount(account);
        }

    } catch { /* rien à oublier */ }
}


/* ==============================
   DÉCONNEXION
============================== */

async function logoutMicrosoft() {
    try {

        cancelLogin();

        const cachePath =
            getCachePath();

        if (fs.existsSync(cachePath)) {
            fs.unlinkSync(cachePath);
        }

        const accounts =
            await pca
                .getTokenCache()
                .getAllAccounts();

        for (
            const account
            of accounts
        ) {
            await pca
                .getTokenCache()
                .removeAccount(
                    account
                );
        }

        return {
            success: true
        };

    } catch (error) {

        return {
            success: false,
            error: error.message
        };
    }
}


module.exports = {
    loginMicrosoft,
    cancelLogin,
    getMicrosoftSession,
    logoutMicrosoft
};