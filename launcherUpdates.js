"use strict";

/*
 * Mise à jour du launcher lui-même (electron-updater + GitHub Releases).
 * Indépendante de la mise à jour du modpack. Désactivée en développement
 * (application non empaquetée) : rien ne se passe avec `npm start`.
 */

function initLauncherUpdates({ app, notify, log = console }) {

    if (!app.isPackaged) return null;

    let autoUpdater;

    try {
        ({ autoUpdater } = require("electron-updater"));
    } catch (error) {
        log.warn("[CobbleRealm] electron-updater indisponible :", error.message);
        return null;
    }

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;      // installée à la fermeture du launcher
    autoUpdater.allowPrerelease = false;          // les pre-releases sont ignorées

    autoUpdater.on("update-available", (info) => notify({ state: "downloading", version: info.version }));
    autoUpdater.on("update-downloaded", (info) => notify({ state: "ready", version: info.version }));

    /* Erreur silencieuse pour le joueur (pas de réseau, pas de release...) : le modpack reste utilisable. */
    autoUpdater.on("error", (error) => log.warn("[CobbleRealm] Mise à jour du launcher :", String(error && error.message).slice(0, 200)));

    autoUpdater.checkForUpdates().catch(() => {});

    return {
        /* Installation SILENCIEUSE puis relance automatique : sans ça, l'installeur s'affiche en assistant (étapes à cliquer)
           et reste ouvert tant que le joueur n'a pas répondu. */
        installNow: () => autoUpdater.quitAndInstall(true, true)
    };
}

module.exports = { initLauncherUpdates };
