"use strict";

/*
 * Erreurs de mise à jour. Les messages sont destinés au joueur :
 * en français, clairs, sans jargon, et sans aucune donnée sensible.
 */

class UpdateError extends Error {

    /**
     * @param {string} code  OFFLINE | SERVER | CORRUPT | DISK_FULL | FILE_LOCKED |
     *                       MANIFEST_INVALID | FORBIDDEN_HOST | MISSING_REMOTE | ABORTED | UNKNOWN
     */
    constructor(code, message, { cause = null, canRepair = false, details = null } = {}) {
        super(message);
        this.name = "UpdateError";
        this.code = code;
        this.cause = cause;
        this.canRepair = canRepair;
        this.details = details;
    }

    toJSON() {
        return { code: this.code, message: this.message, canRepair: this.canRepair };
    }
}

const MESSAGES = {
    OFFLINE: "Impossible de se connecter à Internet. Vérifie ta connexion puis réessaie.",
    SERVER: "Le serveur de mise à jour (GitHub) est momentanément inaccessible. Réessaie dans quelques minutes.",
    FILE_LOCKED: "Un fichier du jeu est utilisé par un autre programme. Ferme Minecraft et les autres launchers, puis réessaie.",
    MANIFEST_INVALID: "La liste de mise à jour reçue est invalide. Préviens l'équipe CobbleRealm si le problème continue.",
    FORBIDDEN_HOST: "Une adresse de téléchargement non autorisée a été refusée par sécurité. Préviens l'équipe CobbleRealm.",
    ABORTED: "La mise à jour a été interrompue.",
    UNKNOWN: "Une erreur inattendue est survenue pendant la mise à jour. Réessaie, ou utilise « Réparer l'installation »."
};

const mo = (bytes) => `${Math.ceil(bytes / 1048576)} Mo`;

function corruptError(label, cause) {
    return new UpdateError(
        "CORRUPT",
        `Le fichier « ${label} » est resté corrompu après 3 essais. Utilise « Réparer l'installation », ` +
        "ou préviens l'équipe CobbleRealm si le problème continue.",
        { cause, canRepair: true }
    );
}

function diskFullError(neededBytes) {
    return new UpdateError(
        "DISK_FULL",
        `Il n'y a plus assez d'espace disque. Libère au moins ${mo(neededBytes)} sur ton disque puis réessaie.`
    );
}

function missingRemoteError(label) {
    return new UpdateError(
        "MISSING_REMOTE",
        `Le fichier « ${label} » est introuvable sur le serveur. Préviens l'équipe CobbleRealm.`
    );
}

/* Transforme n'importe quelle erreur système/réseau en UpdateError lisible. */
function toUpdateError(error) {

    if (error instanceof UpdateError) return error;

    const code = error && error.code;
    const status = error && error.httpStatus;

    if (code === "ENOSPC") return new UpdateError("DISK_FULL", "Il n'y a plus d'espace disque. Libère de la place puis réessaie.", { cause: error });
    if (["EBUSY", "EPERM", "EACCES"].includes(code)) return new UpdateError("FILE_LOCKED", MESSAGES.FILE_LOCKED, { cause: error });
    if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "ECONNRESET",
        "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "ERR_STREAM_PREMATURE_CLOSE"].includes(code)) {
        return new UpdateError("OFFLINE", MESSAGES.OFFLINE, { cause: error });
    }
    if (status) return new UpdateError("SERVER", MESSAGES.SERVER, { cause: error });
    if (error && error.name === "AbortError") return new UpdateError("ABORTED", MESSAGES.ABORTED, { cause: error });

    return new UpdateError("UNKNOWN", MESSAGES.UNKNOWN, { cause: error });
}

const e = (code, extra) => new UpdateError(code, MESSAGES[code], extra);

module.exports = {
    UpdateError, MESSAGES, mo,
    corruptError, diskFullError, missingRemoteError, toUpdateError,
    offlineError: (cause) => e("OFFLINE", { cause }),
    serverError: (cause) => e("SERVER", { cause }),
    forbiddenHostError: (url) => e("FORBIDDEN_HOST", { details: url }),
    manifestInvalidError: (details) => e("MANIFEST_INVALID", { details })
};
