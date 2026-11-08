"use strict";

/*
 * Transforme n'importe quelle erreur technique en message clair, en français, pour le joueur.
 * Aucun détail technique (chemin, adresse, jeton) : le détail complet est dans le rapport de support.
 *
 * Résultat : { code, title, message, actions, canRepair }
 * Actions possibles : "retry" (Réessayer), "repair" (Réparer l'installation), "copy" (Copier le rapport),
 *                     "help" (Obtenir de l'aide), "switchAccount" (Changer de compte)
 */

const BASE_ACTIONS = ["copy", "help"];

const TITLES = {
    update: "Mise à jour impossible",
    microsoft: "Connexion Microsoft impossible",
    "minecraft-auth": "Connexion à Minecraft impossible",
    java: "Java indisponible",
    fabric: "Fabric indisponible",
    launch: "Minecraft n'a pas pu démarrer",
    "game-exit": "Minecraft s'est arrêté"
};

const REPAIRABLE_UPDATE_CODES = ["CORRUPT", "UNKNOWN", "MISSING_REMOTE"];

function networkLike(error) {

    const code = error && error.code;
    const text = String((error && error.message) || "");

    return (
        ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "ETIMEDOUT", "ECONNRESET", "OFFLINE"].includes(code) ||
        /fetch failed|network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo/i.test(text)
    );
}

function describeError({ step, error = {} }) {

    const code = (error && error.code) || null;
    const status = error && error.status;
    const text = String((error && error.message) || "");

    /* ---- Mise à jour du modpack : les messages sont déjà rédigés pour le joueur ---- */
    if (step === "update") {

        const known = typeof code === "string" && /^[A-Z_]+$/.test(code) && text;

        return {
            code: known ? code : "UPDATE_FAILED",
            title: TITLES.update,
            message: known ? text : "Une erreur inattendue est survenue pendant la mise à jour. Réessaie, ou utilise « Réparer l'installation ».",
            actions: ["retry", ...(error.canRepair || REPAIRABLE_UPDATE_CODES.includes(code) || !known ? ["repair"] : []), ...BASE_ACTIONS],
            canRepair: Boolean(error.canRepair)
        };
    }

    /* ---- Connexion Microsoft ---- */
    if (step === "microsoft") {

        if (code === "MICROSOFT_CANCELLED" || /annul|cancel/i.test(text)) {
            return {
                code: "MICROSOFT_CANCELLED",
                title: "Connexion annulée",
                message: "Tu as annulé la connexion Microsoft. Clique sur JOUER pour réessayer.",
                actions: ["retry"],
                canRepair: false
            };
        }

        if (code === "MICROSOFT_EXPIRED" || /expir/i.test(text)) {
            return {
                code: "MICROSOFT_EXPIRED",
                title: TITLES.microsoft,
                message: "Le code de connexion a expiré. Clique sur JOUER pour en obtenir un nouveau.",
                actions: ["retry", ...BASE_ACTIONS],
                canRepair: false
            };
        }

        return {
            code: "MICROSOFT_FAILED",
            title: TITLES.microsoft,
            message: networkLike(error)
                ? "Impossible de joindre Microsoft. Vérifie ta connexion Internet puis réessaie."
                : "La connexion à ton compte Microsoft a échoué. Réessaie, ou change de compte si le problème continue.",
            actions: ["retry", "switchAccount", ...BASE_ACTIONS],
            canRepair: false
        };
    }

    /* ---- Services Minecraft (propriété du jeu, droits) ---- */
    if (step === "minecraft-auth") {

        if (/ne semble pas posséder|non détecté|not.*own/i.test(text)) {
            return {
                code: "NO_MINECRAFT",
                title: "Minecraft Java Edition introuvable",
                message: "Ce compte Microsoft ne possède pas Minecraft Java Edition. Connecte-toi avec le compte qui a acheté le jeu.",
                actions: ["switchAccount", ...BASE_ACTIONS],
                canRepair: false
            };
        }

        if (status === 429) {
            return {
                code: "MINECRAFT_RATE_LIMIT",
                title: TITLES["minecraft-auth"],
                message: "Trop de tentatives de connexion. Attends quelques minutes avant de réessayer.",
                actions: ["retry", ...BASE_ACTIONS],
                canRepair: false
            };
        }

        if (status === 401 || status === 403) {
            return {
                code: "MINECRAFT_DENIED",
                title: TITLES["minecraft-auth"],
                message: `Les services Minecraft ont refusé la connexion (code ${status}). Essaie de te reconnecter avec ton compte, ou demande de l'aide.`,
                actions: ["switchAccount", "retry", ...BASE_ACTIONS],
                canRepair: false
            };
        }

        if (!status && networkLike(error)) {
            return {
                code: "OFFLINE",
                title: TITLES["minecraft-auth"],
                message: "Impossible de joindre les services Minecraft. Vérifie ta connexion Internet puis réessaie.",
                actions: ["retry", ...BASE_ACTIONS],
                canRepair: false
            };
        }

        return {
            code: "MINECRAFT_AUTH_FAILED",
            title: TITLES["minecraft-auth"],
            message: "La connexion aux services Minecraft a échoué. Réessaie dans quelques instants.",
            actions: ["retry", ...BASE_ACTIONS],
            canRepair: false
        };
    }

    /* ---- Java, Fabric : nos propres messages (déjà en français), sinon message générique ---- */
    if (step === "java" || step === "fabric") {

        const name = step === "java" ? "Java" : "Fabric";
        const ours = /^(Impossible|Aucun|Le Java|Java |Fabric |Le profil|Versions|L'archive)/.test(text);
        const known = typeof code === "string" && /^[A-Z_]+$/.test(code) && text;

        return {
            code: known ? code : `${name.toUpperCase()}_FAILED`,
            title: TITLES[step],
            message: known || ours ? text : `${name} n'a pas pu être préparé. Vérifie ta connexion Internet puis réessaie.`,
            actions: ["retry", ...(known && REPAIRABLE_UPDATE_CODES.includes(code) ? ["repair"] : []), ...BASE_ACTIONS],
            canRepair: false
        };
    }

    /* ---- Démarrage du jeu ---- */
    if (step === "launch") {
        return {
            code: "LAUNCH_FAILED",
            title: TITLES.launch,
            message: "Minecraft n'a pas pu démarrer. Réessaie, ou répare l'installation si le problème continue.",
            actions: ["retry", "repair", ...BASE_ACTIONS],
            canRepair: true
        };
    }

    /* ---- Le jeu s'est arrêté avec une erreur ---- */
    if (step === "game-exit") {
        return {
            code: "GAME_EXIT",
            title: TITLES["game-exit"],
            message: `Minecraft s'est arrêté avec une erreur (code ${error.exitCode}). ` +
                "Si ce n'était pas voulu, copie le rapport et envoie-le à l'équipe sur Discord.",
            actions: ["retry", ...BASE_ACTIONS],
            canRepair: false
        };
    }

    return {
        code: "UNKNOWN",
        title: "Une erreur est survenue",
        message: "Une erreur inattendue est survenue. Réessaie, ou copie le rapport et demande de l'aide.",
        actions: ["retry", ...BASE_ACTIONS],
        canRepair: false
    };
}

module.exports = { describeError };
