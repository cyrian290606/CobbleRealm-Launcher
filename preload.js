const {
    contextBridge,
    ipcRenderer
} = require("electron");

contextBridge.exposeInMainWorld(
    "cobbleRealm",
    {

        /* ==============================
           MICROSOFT
        ============================== */

        loginMicrosoft: () =>
            ipcRenderer.invoke(
                "microsoft-login"
            ),

        /* Annule la connexion en cours (la fenêtre du code se ferme) */
        cancelMicrosoftLogin: () =>
            ipcRenderer.invoke(
                "microsoft-cancel-login"
            ),

        /* Copie le code de connexion en cours dans le presse-papiers */
        copyMicrosoftCode: () =>
            ipcRenderer.invoke(
                "copy-login-code"
            ),

        /* Rouvre la page Microsoft du code en cours (adresse choisie par le launcher) */
        openMicrosoftLoginPage: () =>
            ipcRenderer.invoke(
                "open-microsoft-login-page"
            ),

        getMicrosoftSession: () =>
            ipcRenderer.invoke(
                "microsoft-session"
            ),

        logoutMicrosoft: () =>
            ipcRenderer.invoke(
                "microsoft-logout"
            ),

        onMicrosoftDeviceCode: (
            callback
        ) => {

            /* data === null : la fenêtre de code doit se fermer */
            ipcRenderer.on(
                "microsoft-device-code",

                (
                    event,
                    data
                ) => {

                    callback(data);
                }
            );
        },


        /* ==============================
           MINECRAFT
        ============================== */

        testMinecraft: () =>
            ipcRenderer.invoke(
                "minecraft-test"
            ),

        launchMinecraft: (options = {}) =>
            ipcRenderer.invoke(
                "launch-minecraft",
                options
            ),

        getLauncherSettings: () =>
            ipcRenderer.invoke(
                "get-launcher-settings"
            ),

        saveLauncherSettings: (settings) =>
            ipcRenderer.invoke(
                "save-launcher-settings",
                settings
            ),

        checkCobbleRealmUpdate: () =>
            ipcRenderer.invoke(
                "check-cobblerealm-update"
            ),

        getLauncherNews: () =>
            ipcRenderer.invoke(
                "get-launcher-news"
            ),


        /* ==============================
           LIENS EXTERNES
        ============================== */

        openDiscord: () =>
            ipcRenderer.invoke(
                "open-discord"
            ),

        openSite: () =>
            ipcRenderer.invoke(
                "open-site"
            ),

        openShop: () =>
            ipcRenderer.invoke(
                "open-shop"
            ),


        /* ==============================
           ÉVÉNEMENTS MINECRAFT
        ============================== */

        onMinecraftLog: (
            callback
        ) => {

            ipcRenderer.on(
                "minecraft-log",

                (
                    event,
                    message
                ) => {

                    callback(message);
                }
            );
        },

        onMinecraftProgress: (
            callback
        ) => {

            ipcRenderer.on(
                "minecraft-progress",

                (
                    event,
                    progress
                ) => {

                    callback(progress);
                }
            );
        },

        onMinecraftStatus: (
            callback
        ) => {

            ipcRenderer.on(
                "minecraft-status",

                (
                    event,
                    data
                ) => {

                    callback(data);
                }
            );
        },


        /* ==============================
           MISE À JOUR DU LAUNCHER
        ============================== */

        onLauncherUpdateStatus: (
            callback
        ) => {

            ipcRenderer.on(
                "launcher-update-status",

                (
                    event,
                    data
                ) => {

                    callback(data);
                }
            );
        },


        /* ==============================
           MISE À JOUR DU MODPACK
        ============================== */

        /* { step, message, file, filesDone, filesTotal, bytesDone, bytesTotal, percent, speed } */
        onUpdateProgress: (callback) => {
            ipcRenderer.on("update-progress", (event, data) => callback(data));
        },

        /* { code, title, message, actions: ["retry","repair","copy","help","switchAccount"], canRepair } */
        onLaunchError: (callback) => {
            ipcRenderer.on("launch-error", (event, data) => callback(data));
        },

        /* Copie dans le presse-papiers un rapport de support sans donnée personnelle */
        copySupportReport: () =>
            ipcRenderer.invoke(
                "copy-support-report"
            ),

        /* { message } : lancement hors-ligne sur la version installée */
        onUpdateWarning: (callback) => {
            ipcRenderer.on("update-warning", (event, data) => callback(data));
        },

        repairInstallation: () =>
            ipcRenderer.invoke(
                "repair-installation"
            ),


        /* ==============================
           MISE À JOUR DU LAUNCHER LUI-MÊME
        ============================== */

        /* { state: "downloading" | "ready", version } */
        onLauncherSelfUpdate: (callback) => {
            ipcRenderer.on("launcher-self-update", (event, data) => callback(data));
        },

        installLauncherUpdate: () =>
            ipcRenderer.invoke(
                "install-launcher-update"
            )
    }
);