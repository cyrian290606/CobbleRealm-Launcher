"use strict";

/*
 * Profil Fabric Loader. La version de Minecraft et celle de Fabric viennent du manifest :
 * si elles changent, un nouveau profil est téléchargé et l'ancien reste en place (sans effet).
 */

const fs = require("fs");
const path = require("path");
const { getJson } = require("./updater/http");

const SAFE_VERSION = /^[\w.\-]+$/;

function profileIdFor(minecraft, fabricLoader) {
    return `fabric-loader-${fabricLoader}-${minecraft}`;
}

function profilePathFor(root, id) {
    return path.join(root, "versions", id, `${id}.json`);
}

function isProfileValid(root, minecraft, fabricLoader) {

    const id = profileIdFor(minecraft, fabricLoader);

    try {
        const profile = JSON.parse(fs.readFileSync(profilePathFor(root, id), "utf8"));

        return Boolean(
            profile &&
            profile.id === id &&
            profile.inheritsFrom === minecraft &&
            typeof profile.mainClass === "string" && profile.mainClass.length > 0 &&
            Array.isArray(profile.libraries)
        );

    } catch {
        return false;
    }
}

/**
 * Garantit la présence du profil Fabric et retourne son identifiant.
 * @param {object} p { root, minecraft, fabricLoader, onLog, metaBase, allowLocal }
 */
async function ensureFabricProfile({
    root, minecraft, fabricLoader, onLog = () => {},
    metaBase = "https://meta.fabricmc.net", allowLocal = false
}) {

    if (!SAFE_VERSION.test(minecraft) || !SAFE_VERSION.test(fabricLoader)) {
        throw new Error("Versions Minecraft/Fabric invalides.");
    }

    const id = profileIdFor(minecraft, fabricLoader);

    if (isProfileValid(root, minecraft, fabricLoader)) {
        onLog(`[CobbleRealm] Fabric Loader ${fabricLoader} déjà préparé.`);
        return id;
    }

    onLog(`[CobbleRealm] Préparation de Fabric Loader ${fabricLoader} pour Minecraft ${minecraft}...`);

    let profile;

    try {
        profile = await getJson(
            `${metaBase}/v2/versions/loader/${encodeURIComponent(minecraft)}/${encodeURIComponent(fabricLoader)}/profile/json`,
            { allowedHosts: ["meta.fabricmc.net"], allowLocal, timeoutMs: 20000 }
        );
    } catch (error) {
        throw new Error(
            error && error.httpStatus === 400 || error && error.httpStatus === 404
                ? `Fabric ${fabricLoader} n'existe pas pour Minecraft ${minecraft}. Préviens l'équipe CobbleRealm.`
                : "Impossible de télécharger Fabric. Vérifie ta connexion Internet puis réessaie."
        );
    }

    if (!profile || !profile.id || !profile.mainClass || !Array.isArray(profile.libraries)) {
        throw new Error("Le profil Fabric reçu est invalide.");
    }

    profile.id = id;
    profile.inheritsFrom = minecraft;

    const file = profilePathFor(root, id);

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(profile, null, 2), "utf8");
    fs.renameSync(`${file}.tmp`, file);

    onLog(`[CobbleRealm] Fabric Loader ${fabricLoader} préparé avec succès.`);

    return id;
}

module.exports = { ensureFabricProfile, isProfileValid, profileIdFor };
