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
        }
    }
);