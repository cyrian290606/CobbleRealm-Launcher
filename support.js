"use strict";

/*
 * Rapport de support : texte que le joueur peut copier et envoyer à l'équipe.
 * Règle absolue : aucune donnée personnelle ni secrète ne doit en sortir
 * (jetons, e-mail, pseudo, identifiants, nom d'utilisateur Windows, adresses IP).
 */

const os = require("os");

const PLACEHOLDER = {
    secret: "<secret>",
    email: "<e-mail>",
    uuid: "<identifiant>",
    pseudo: "<pseudo>",
    user: "<utilisateur>",
    ip: "<adresse-ip>"
};

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Retire d'un texte tout ce qui est personnel ou secret.
 * @param {string} text
 * @param {object} [options]
 * @param {string[]} [options.privateStrings]  valeurs exactes à masquer partout (pseudo, e-mail du compte...)
 * @param {string[]} [options.userNames]       noms d'utilisateur Windows à masquer partout
 */
function sanitize(text, { privateStrings = [], userNames = [] } = {}) {

    let out = String(text === undefined || text === null ? "" : text);

    /* 1. Jetons et arguments sensibles de la ligne de commande Java */
    out = out
        .replace(/(--(?:accessToken|session|clientId|xuid|uuid|username)\s+)\S+/gi, `$1${PLACEHOLDER.secret}`)
        .replace(/\bBearer\s+[\w.\-~+/]+=*/gi, `Bearer ${PLACEHOLDER.secret}`)
        .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, PLACEHOLDER.secret)
        .replace(/\b(?:access_token|refresh_token|id_token|token)["'\s:=]+[\w.\-~+/]{16,}/gi, `token=${PLACEHOLDER.secret}`)
        .replace(/\b[A-Za-z0-9_\-]{40,}\b/g, PLACEHOLDER.secret);

    /* 2. Lignes où le jeu ou le launcher écrivent le pseudo */
    out = out
        .replace(/(Setting user:\s*)\S+/gi, `$1${PLACEHOLDER.pseudo}`)
        .replace(/(Profil récupéré\s*:\s*)\S+/gi, `$1${PLACEHOLDER.pseudo}`)
        .replace(/(connecté en tant que\s*)\S+/gi, `$1${PLACEHOLDER.pseudo}`);

    /* 3. Adresses e-mail, identifiants (UUID), adresses IP (sauf la machine locale) */
    out = out
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, PLACEHOLDER.email)
        .replace(/\b[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b/gi, PLACEHOLDER.uuid)
        .replace(/\b(?!127\.0\.0\.1\b)(?:\d{1,3}\.){3}\d{1,3}\b/g, PLACEHOLDER.ip);

    /* 4. Chemins Windows contenant le nom d'utilisateur : C:\Users\Nom\... ou C:/Users/Nom/... */
    out = out.replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"'<>|:*?]+/gi, `$1${PLACEHOLDER.user}`)
        .replace(/(\/(?:c|d|e)\/Users\/)[^\\/\s"']+/gi, `$1${PLACEHOLDER.user}`);

    /* 5. Valeurs exactes connues (pseudo, e-mail, nom d'utilisateur Windows), partout dans le texte */
    for (const value of privateStrings) {
        if (typeof value === "string" && value.trim().length >= 3) {
            out = out.replace(new RegExp(escapeRegExp(value.trim()), "gi"), PLACEHOLDER.pseudo);
        }
    }

    for (const name of userNames) {
        if (typeof name === "string" && name.trim().length >= 3) {
            out = out.replace(new RegExp(escapeRegExp(name.trim()), "gi"), PLACEHOLDER.user);
        }
    }

    return out;
}

/** Noms de l'utilisateur Windows à masquer partout (identifiant de session et dossier personnel). */
function currentUserNames() {

    const names = new Set();

    try {
        const info = os.userInfo();
        if (info.username) names.add(info.username);
        if (info.homedir) names.add(info.homedir.split(/[\\/]/).filter(Boolean).pop());
    } catch { /* non disponible */ }

    if (process.env.USERNAME) names.add(process.env.USERNAME);

    return [...names].filter((n) => n && n.length >= 3);
}

const pad = (n) => String(n).padStart(2, "0");

function formatDate(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Construit le texte du rapport.
 * @param {object} p
 * @param {object} p.info     { launcher, pack, minecraft, fabric, java, ramAllocatedGb }
 * @param {object} [p.error]  { code, message }
 * @param {string[]} [p.logs] dernières lignes du journal
 * @param {string[]} [p.privateStrings]
 */
function buildReport({ info = {}, error = null, logs = [], privateStrings = [], now = new Date(), system = {} }) {

    const options = { privateStrings, userNames: currentUserNames() };
    const totalGb = system.totalMemGb !== undefined ? system.totalMemGb : Math.round(os.totalmem() / 1024 ** 3);
    const windows = system.windows || `${os.type()} ${os.release()} (${os.arch()})`;

    const lines = [
        "=== Rapport CobbleRealm ===",
        `Date : ${formatDate(now)}`,
        `Launcher : ${info.launcher || "inconnu"}`,
        `Pack : ${info.pack ? "v" + info.pack : "non installé"}`,
        `Minecraft : ${info.minecraft || "inconnu"} · Fabric : ${info.fabric || "inconnu"} · Java : ${info.java || "inconnu"}`,
        `Système : ${windows}`,
        `Mémoire : ${totalGb} Go au total, ${info.ramAllocatedGb ? info.ramAllocatedGb + " Go alloués à Minecraft" : "allocation inconnue"}`
    ];

    if (error) {
        lines.push(`Erreur : ${error.code || "inconnue"} — ${error.message || ""}`);
    }

    lines.push("", "--- Dernières lignes du journal ---");

    const recent = logs.slice(-50);
    lines.push(...(recent.length ? recent : ["(aucune ligne)"]));

    return sanitize(lines.join("\n"), options);
}

module.exports = { sanitize, buildReport, currentUserNames, PLACEHOLDER };
