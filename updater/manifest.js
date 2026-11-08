"use strict";

/*
 * Récupération et validation du manifest (schéma v2).
 * Toute donnée du manifest est considérée comme non fiable tant qu'elle n'a pas été validée ici.
 */

const path = require("path");
const { getJson, checkUrl } = require("./http");
const { UpdateError, toUpdateError, manifestInvalidError } = require("./errors");

/* Domaines autorisés */
const FILE_HOSTS = [
    "github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    "*.githubusercontent.com"
];

/* Le manifest lui-même peut aussi venir de GitHub Pages. */
const MANIFEST_HOSTS = [...FILE_HOSTS, "cyrian290606.github.io"];

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/* Retourne un message d'erreur, ou null si le chemin relatif est sûr. */
function validateRelPath(rel) {

    if (typeof rel !== "string" || rel.length === 0) return "chemin vide";
    if (rel.length > 240) return "chemin trop long";
    if (rel.includes("\\")) return "antislash interdit (utiliser '/')";
    if (rel.includes("\0")) return "caractère nul";
    if (rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) return "chemin absolu";

    for (const segment of rel.split("/")) {

        if (segment === "") return "segment vide";
        if (segment === "." || segment === "..") return "segment '.' ou '..'";
        if (/[<>:"|?*\x00-\x1f]/.test(segment)) return "caractère interdit sous Windows";
        if (/[. ]$/.test(segment)) return "nom finissant par un point ou un espace";
        if (WINDOWS_RESERVED.test(segment.split(".")[0])) return "nom réservé Windows";
    }

    return null;
}

/* Chemin absolu garanti à l'intérieur de root, sinon erreur. */
function resolveInside(root, rel) {

    const problem = validateRelPath(rel);

    if (problem) throw manifestInvalidError(`${rel} : ${problem}`);

    const base = path.resolve(root);
    const full = path.resolve(base, ...rel.split("/"));

    if (full !== base && !full.startsWith(base + path.sep)) {
        throw manifestInvalidError(`${rel} : sort du dossier de jeu`);
    }

    return full;
}

function parseVersion(v) {
    return typeof v === "string" && /^\d+(\.\d+){0,3}$/.test(v) ? v.split(".").map(Number) : null;
}

/**
 * Valide un manifest v2. Retourne le manifest, ou lève MANIFEST_INVALID
 * (les détails listent tous les problèmes trouvés).
 */
function validateManifest(manifest, { allowLocal = false } = {}) {

    const problems = [];
    const add = (message) => { if (problems.length < 30) problems.push(message); };

    if (!manifest || typeof manifest !== "object") throw manifestInvalidError("manifest vide");
    if (manifest.schema !== 2) add("schema doit valoir 2");
    if (typeof manifest.version !== "string" || manifest.version.length > 40) add("version invalide");
    if (typeof manifest.minecraft !== "string" || !/^[\w.\-]+$/.test(manifest.minecraft)) add("minecraft invalide");
    if (typeof manifest.fabricLoader !== "string" || !/^[\w.\-]+$/.test(manifest.fabricLoader)) add("fabricLoader invalide");
    if (!Number.isInteger(manifest.java) || manifest.java < 8 || manifest.java > 99) add("java invalide");
    if (!Number.isFinite(manifest.recommendedRamGb) || manifest.recommendedRamGb < 1 || manifest.recommendedRamGb > 64) add("recommendedRamGb invalide");
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) add("aucun fichier");

    const strictDirs = manifest.strictDirs === undefined ? [] : manifest.strictDirs;
    if (!Array.isArray(strictDirs) || strictDirs.some((d) => typeof d !== "string" || validateRelPath(d))) add("strictDirs invalide");

    if (manifest.preserved !== undefined && (!Array.isArray(manifest.preserved) || manifest.preserved.some((p) => typeof p !== "string"))) {
        add("preserved invalide");
    }

    if (Array.isArray(manifest.files)) {

        const seen = new Set();

        for (const f of manifest.files) {

            if (!f || typeof f !== "object") { add("entrée de fichier invalide"); continue; }

            const problem = validateRelPath(f.path);
            if (problem) { add(`${String(f.path).slice(0, 80)} : ${problem}`); continue; }

            const key = f.path.toLowerCase();
            if (seen.has(key)) add(`${f.path} : doublon`);
            seen.add(key);

            if (!/^[0-9a-f]{64}$/.test(f.sha256 || "")) add(`${f.path} : sha256 invalide`);
            if (!Number.isSafeInteger(f.size) || f.size < 0) add(`${f.path} : taille invalide`);
            if (!["managed", "default"].includes(f.policy)) add(`${f.path} : catégorie invalide`);

            try { checkUrl(f.url, { allowedHosts: FILE_HOSTS, allowLocal }); }
            catch { add(`${f.path} : URL non autorisée`); }
        }
    }

    if (problems.length) throw manifestInvalidError(problems);

    return manifest;
}

/**
 * Télécharge et valide le manifest (3 essais, timeout).
 * L'erreur retournée est toujours une UpdateError lisible.
 */
async function fetchManifest(url, {
    retries = 3, retryDelayMs = 800, timeoutMs = 15000, allowLocal = false, signal = null
} = {}) {

    let lastError = null;

    for (let attempt = 0; attempt < retries; attempt++) {

        if (attempt > 0) await new Promise((r) => setTimeout(r, retryDelayMs * attempt));

        try {
            const separator = url.includes("?") ? "&" : "?";

            const manifest = await getJson(`${url}${separator}t=${Date.now()}`, {
                allowedHosts: MANIFEST_HOSTS, allowLocal, timeoutMs, signal
            });

            return validateManifest(manifest, { allowLocal });

        } catch (error) {

            const converted = toUpdateError(error);

            if (converted instanceof SyntaxError || error instanceof SyntaxError) {
                lastError = manifestInvalidError("JSON illisible");
            } else {
                lastError = converted;
            }

            /* Inutile de réessayer : l'erreur ne changera pas. */
            if (["MANIFEST_INVALID", "FORBIDDEN_HOST", "ABORTED"].includes(lastError.code)) throw lastError;
            if (error && error.httpStatus === 404) throw new UpdateError("SERVER", lastError.message, { cause: error });
        }
    }

    throw lastError;
}

module.exports = {
    FILE_HOSTS, MANIFEST_HOSTS,
    validateRelPath, resolveInside, validateManifest, fetchManifest, parseVersion
};
