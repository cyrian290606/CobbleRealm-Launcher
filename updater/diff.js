"use strict";

/*
 * Compare l'état local (lock.json + fichiers présents) au manifest
 * et calcule : quoi télécharger, quoi adopter, quoi retirer.
 *
 * Comparaison par contenu (sha256), jamais par numéro de version :
 * un retour à une ancienne version du manifest fonctionne donc naturellement.
 */

const fs = require("fs");
const path = require("path");
const { resolveInside } = require("./manifest");
const { hashFile, mapLimit } = require("./util");

const lowerKey = (rel) => rel.toLowerCase();

/* Liste récursive des .jar d'un dossier (chemins relatifs avec '/'). */
function listJars(root, dirRel) {

    const out = [];
    const start = resolveInside(root, dirRel);

    const walk = (abs, rel) => {

        let entries;
        try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
        catch { return; }

        for (const entry of entries) {
            const childRel = `${rel}/${entry.name}`;
            if (entry.isDirectory()) walk(path.join(abs, entry.name), childRel);
            else if (entry.isFile() && /\.jar$/i.test(entry.name)) out.push(childRel);
        }
    };

    walk(start, dirRel);
    return out;
}

/**
 * @param {object} p
 * @param {object} p.manifest      manifest validé
 * @param {string} p.gameRoot
 * @param {object|null} p.lock     contenu de lock.json (ou lock.prev.json) ou null
 * @param {boolean} p.repair       true : ignore les raccourcis, rehash tout
 * @param {Map} p.hashCache        cache de hash (clé chemin|taille|mtime)
 * @param {function} p.onScan      (fait, total) pendant les calculs de hash
 */
async function buildPlan({ manifest, gameRoot, lock, repair = false, hashCache = new Map(), onScan = () => {} }) {

    const records = (lock && lock.files) || {};
    const manifestKeys = new Set(manifest.files.map((f) => lowerKey(f.path)));

    const needsDownload = [];   // { file, reason }
    const adopted = [];         // fichiers déjà conformes mais pas encore dans le lock
    const unchanged = [];       // fichiers conformes, déjà connus du lock
    const toHash = [];          // { file, dest, st }

    for (const file of manifest.files) {

        const dest = resolveInside(gameRoot, file.path);
        let st = null;

        try { st = fs.lstatSync(dest); } catch { /* absent */ }

        if (!st || !st.isFile()) {
            needsDownload.push({ file, reason: st ? "remplacé" : "absent" });
            continue;
        }

        /* default : jamais écrasé s'il existe. */
        if (file.policy === "default") continue;

        const record = records[file.path];

        if (!repair && record && record.sha256 === file.sha256 &&
            record.size === st.size && Math.abs(record.mtimeMs - st.mtimeMs) < 2) {     // tolérance d'arrondi du système de fichiers
            unchanged.push({ file, record });
            continue;
        }

        if (st.size !== file.size) {
            needsDownload.push({ file, reason: "modifié" });
            continue;
        }

        toHash.push({ file, dest, st });
    }

    /* Calcul des hash (migration, réparation, fichiers douteux). */
    let done = 0;

    await mapLimit(toHash, 4, async ({ file, dest, st }) => {

        const key = `${file.path}|${st.size}|${Math.floor(st.mtimeMs)}`;
        let sha = hashCache.get(key);

        if (!sha) {
            sha = await hashFile(dest);
            hashCache.set(key, sha);
        }

        if (sha === file.sha256) {
            adopted.push({
                path: file.path, sha256: sha, size: st.size,
                mtimeMs: Math.floor(st.mtimeMs), policy: file.policy
            });
        } else {
            needsDownload.push({ file, reason: "corrompu ou modifié" });
        }

        onScan(++done, toHash.length);
    });

    /* Ordre déterministe (celui du manifest), indépendant de la vitesse des calculs de hash. */
    const order = new Map(manifest.files.map((f, i) => [f.path, i]));
    needsDownload.sort((x, y) => order.get(x.file.path) - order.get(y.file.path));

    /* Fichiers installés par le launcher puis retirés du manifest (managed seulement). */
    const toRemove = [];

    for (const [rel, record] of Object.entries(records)) {

        if (record.policy !== "managed") continue;
        if (manifestKeys.has(lowerKey(rel))) continue;

        try {
            if (fs.lstatSync(resolveInside(gameRoot, rel)).isFile()) toRemove.push(rel);
        } catch { /* déjà absent ou chemin invalide : on ignore */ }
    }

    /* Mode strict : tout .jar absent du manifest est retiré (un mod en trop empêche de se connecter). */
    const strictRemovals = [];

    for (const dir of manifest.strictDirs || []) {

        const prefix = `${lowerKey(dir)}/`;

        /* Garde-fou : un manifest sans aucun fichier dans ce dossier ne doit jamais tout retirer. */
        if (!manifest.files.some((f) => lowerKey(f.path).startsWith(prefix))) continue;

        for (const jar of listJars(gameRoot, dir)) {
            if (!manifestKeys.has(lowerKey(jar)) && !toRemove.includes(jar)) strictRemovals.push(jar);
        }
    }

    /* Liste explicite (manifest.remove) : ces fichiers exacts sont retirés s'ils existent. */
    const explicitRemovals = [];

    for (const rel of manifest.remove || []) {

        if (manifestKeys.has(lowerKey(rel)) || toRemove.includes(rel) || strictRemovals.includes(rel)) continue;

        try {
            if (fs.lstatSync(resolveInside(gameRoot, rel)).isFile()) explicitRemovals.push(rel);
        } catch { /* absent : rien à faire */ }
    }

    /* Téléchargements dédoublonnés par contenu. */
    const bySha = new Map();

    for (const { file } of needsDownload) {
        const entry = bySha.get(file.sha256) || { sha256: file.sha256, size: file.size, url: file.url, label: path.posix.basename(file.path), paths: [] };
        entry.paths.push(file.path);
        bySha.set(file.sha256, entry);
    }

    const uniqueDownloads = [...bySha.values()];

    return {
        needsDownload,
        uniqueDownloads,
        adopted,
        unchanged,
        toRemove,
        strictRemovals,
        explicitRemovals,
        bytesToDownload: uniqueDownloads.reduce((sum, d) => sum + d.size, 0),
        isEmpty: needsDownload.length === 0 && toRemove.length === 0 &&
            strictRemovals.length === 0 && explicitRemovals.length === 0
    };
}

module.exports = { buildPlan, listJars };
