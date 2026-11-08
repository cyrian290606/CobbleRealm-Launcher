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

async function loginMicrosoft(
    onDeviceCode
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

                        scopes: [
                            "XboxLive.signin",
                            "offline_access"
                        ]
                    });

                saveCache();

                return {
                    success: true,

                    silent: true,

                    accessToken:
                        silentResponse.accessToken,

                    account: {
                        username:
                            account.username,

                        homeAccountId:
                            account.homeAccountId
                    }
                };

            } catch (silentError) {
                console.log(
                    "Session silencieuse expirée, nouvelle connexion requise."
                );
            }
        }


        const deviceCodeRequest = {

            scopes: [
                "XboxLive.signin",
                "offline_access"
            ],

            deviceCodeCallback: (
                response
            ) => {

                if (onDeviceCode) {

                    onDeviceCode({
                        userCode:
                            response.userCode,

                        verificationUri:
                            response.verificationUri,

                        message:
                            response.message
                    });

                }
            }
        };


        const response =
            await pca.acquireTokenByDeviceCode(
                deviceCodeRequest
            );


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
                response.account
                    ? {
                        username:
                            response.account.username,

                        homeAccountId:
                            response.account.homeAccountId
                    }
                    : null
        };


    } catch (error) {

        console.error(
            "Erreur pendant la connexion Microsoft :",
            error
        );

        return {
            success: false,

            error:
                error.message ||
                "Erreur inconnue pendant la connexion Microsoft."
        };
    }
}


/* ==============================
   DÉCONNEXION
============================== */

async function logoutMicrosoft() {
    try {

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
    getMicrosoftSession,
    logoutMicrosoft
};