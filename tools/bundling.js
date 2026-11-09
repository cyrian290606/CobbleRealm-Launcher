"use strict";

/*
 * Regroupement des petits fichiers en « bundles » (outil administrateur, fonction pure).
 *
 * But : un modpack contient des milliers de très petits fichiers (96 % font 64 Ko ou moins, pour 2 % du volume). Les
 * envoyer et les télécharger un par un coûte des milliers de requêtes. On les regroupe donc en lots d'environ 1 à 2 Mo.
 *
 * Contrainte principale : STABILITÉ. Quand un seul fichier change, le moins possible de bundles doit changer
 * (un bundle modifié = un nouveau fichier à envoyer et à retélécharger par tous les joueurs). Règles :
 *   - le bundle d'un fichier ne dépend QUE de son chemin et du volume de son dossier, jamais de l'ordre ni des autres versions ;
 *   - les fichiers d'un même dossier restent ensemble (ils changent souvent ensemble) ;
 *   - un dossier trop gros est réparti selon le hash du CHEMIN (un fichier modifié garde son bundle), avec un nombre de lots PUISSANCE DE 2 :
 *     ce nombre ne change que lorsque le dossier double de taille (rare), pas à chaque ajout de fichier.
 */

const DEFAULTS = {
    smallBytes: 64 * 1024,            // fichiers regroupés : taille maximale
    targetBytes: 2 * 1024 * 1024,     // taille visée d'un bundle (au plus ~2 Mo)
    minGroupBytes: 256 * 1024,        // un dossier plus petit que ça est regroupé avec son dossier parent
    maxDepth: 2                       // profondeur de dossiers utilisée pour regrouper
};

const crypto = require("crypto");
const nextPowerOfTwo = (n) => { let p = 1; while (p < n) p *= 2; return p; };
const ROOT = "(racine)";

/**
 * @param {Array<{sha256:string, size:number, paths:string[]}>} contents  contenus distincts à regrouper
 * @returns {Array<{ key:string, bucket:number, buckets:number, shas:string[], bytes:number }>}
 */
function planBundles(contents, options = {}) {

    const o = { ...DEFAULTS, ...options };

    /* Chemin de référence d'un contenu : le plus petit (stable, indépendant de l'ordre de parcours). */
    const items = contents.map((c) => ({ sha256: c.sha256, size: c.size, path: [...c.paths].sort()[0] }));

    const dirOf = (rel, depth) => rel.split("/").slice(0, -1).slice(0, depth).join("/");

    /* Volume par dossier et par profondeur (1..maxDepth) */
    const totals = new Map();

    for (const item of items) {
        for (let depth = 1; depth <= o.maxDepth; depth++) {
            const key = dirOf(item.path, depth);
            if (key) totals.set(key, (totals.get(key) || 0) + item.size);
        }
    }

    /* Dossier le plus profond (≤ maxDepth) qui est assez gros ; sinon dossier racine, sinon « (racine) ». */
    const keyFor = (rel) => {

        for (let depth = o.maxDepth; depth >= 1; depth--) {
            const key = dirOf(rel, depth);
            if (key && (depth === 1 || totals.get(key) >= o.minGroupBytes)) return key;
        }

        return ROOT;
    };

    const groups = new Map();

    for (const item of items) {
        const key = keyFor(item.path);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }

    const result = [];

    for (const key of [...groups.keys()].sort()) {

        const members = groups.get(key);
        const bytes = members.reduce((s, m) => s + m.size, 0);
        const buckets = nextPowerOfTwo(Math.max(1, Math.ceil(bytes / o.targetBytes)));
        const lists = Array.from({ length: buckets }, () => []);

        for (const m of members) lists[parseInt(crypto.createHash("sha256").update(m.path).digest("hex").slice(0, 8), 16) % buckets].push(m);   // selon le CHEMIN : un fichier modifié reste dans le même bundle

        lists.forEach((list, bucket) => {
            if (!list.length) return;
            result.push({ key, bucket, buckets, shas: list.map((m) => m.sha256).sort(), bytes: list.reduce((s, m) => s + m.size, 0) });
        });
    }

    return result;
}

module.exports = { planBundles, DEFAULTS };
