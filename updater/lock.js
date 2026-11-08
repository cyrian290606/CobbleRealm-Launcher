"use strict";

/*
 * lock.json = la liste des fichiers que le launcher a installés + la version.
 *
 * Règle de sécurité : lock.json n'existe qu'entre deux mises à jour terminées.
 * Pendant l'application d'une mise à jour il est mis de côté (lock.prev.json) ;
 * s'il y a un crash, il n'y a plus de lock.json => l'installation n'est PAS
 * considérée comme valide, et lock.prev.json ne sert que d'indice (fichiers
 * installés par le launcher, pour savoir quoi retirer).
 */

const fs = require("fs");
const path = require("path");

const LOCK_NAME = "lock.json";
const PREV_NAME = "lock.prev.json";

function parse(file) {

    try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        if (data && data.schema === 1 && data.files && typeof data.files === "object") return data;
    } catch { /* absent ou illisible */ }

    return null;
}

/** @returns {{lock: object|null, valid: boolean}} valid = installation complète et cohérente */
function readLock(root) {

    const lock = parse(path.join(root, LOCK_NAME));
    if (lock) return { lock, valid: true };

    const previous = parse(path.join(root, PREV_NAME));
    return { lock: previous, valid: false };
}

function atomicWrite(file, text) {

    const tmp = `${file}.tmp`;

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, file);
}

/* À appeler juste avant de toucher aux fichiers du jeu. */
function beginUpdate(root) {

    const lockPath = path.join(root, LOCK_NAME);

    if (fs.existsSync(lockPath)) {
        fs.renameSync(lockPath, path.join(root, PREV_NAME));
    }
}

/* À appeler une fois TOUT appliqué avec succès. */
function commitLock(root, lock) {

    atomicWrite(path.join(root, LOCK_NAME), JSON.stringify(lock, null, 2));
    fs.rmSync(path.join(root, PREV_NAME), { force: true });
}

module.exports = { readLock, beginUpdate, commitLock, LOCK_NAME, PREV_NAME };
