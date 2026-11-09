"use strict";

/*
 * Bundles : format de regroupement des petits fichiers (voir tools/bundling.js pour le « pourquoi »).
 *
 *   [ "CRB1" (4 octets) ][ longueur de l'index (uint32, gros-boutiste) ][ index JSON ][ données concaténées ]
 *   index = { "v": 1, "entries": [ { "sha256", "size", "offset" }, ... ] }   (offset relatif au début des données)
 *
 * Le bundle entier est vérifié (taille + SHA-256 = son nom) par le téléchargement ; chaque fichier extrait est
 * ENCORE vérifié individuellement (SHA-256 du manifest) avant d'être accepté. Un bundle est donc traité comme
 * une donnée non fiable : tout est borné et validé, rien n'est écrit hors du dossier temporaire.
 * Format déterministe (entrées triées) : mêmes fichiers => mêmes octets => même nom => jamais renvoyé.
 */

const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { corruptError } = require("./errors");
const { renameRetry } = require("./util");

const MAGIC = Buffer.from("CRB1");
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 100000;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const SHA = /^[0-9a-f]{64}$/;

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

/** @param {Array<{sha256:string, data:Buffer}>} entries @returns {Buffer} */
function buildBundle(entries) {

    const sorted = [...entries].sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0));
    let offset = 0;
    const index = sorted.map((e) => { const item = { sha256: e.sha256, size: e.data.length, offset }; offset += e.data.length; return item; });
    const header = Buffer.from(JSON.stringify({ v: 1, entries: index }), "utf8");
    const length = Buffer.alloc(4);

    length.writeUInt32BE(header.length);

    return Buffer.concat([MAGIC, length, header, ...sorted.map((e) => e.data)]);
}

/** Lit l'index d'un bundle. Lève une erreur (message technique) si le contenu est invalide. */
function parseBundle(buffer) {

    if (!Buffer.isBuffer(buffer) || buffer.length < 8 || buffer.length > MAX_BUNDLE_BYTES) throw new Error("bundle : taille invalide");
    if (!buffer.subarray(0, 4).equals(MAGIC)) throw new Error("bundle : signature invalide");

    const headerLength = buffer.readUInt32BE(4);

    if (headerLength < 2 || headerLength > MAX_INDEX_BYTES || 8 + headerLength > buffer.length) throw new Error("bundle : index invalide");

    let index;

    try { index = JSON.parse(buffer.subarray(8, 8 + headerLength).toString("utf8")); }
    catch { throw new Error("bundle : index illisible"); }

    if (!index || index.v !== 1 || !Array.isArray(index.entries) || index.entries.length > MAX_ENTRIES) throw new Error("bundle : index invalide");

    const dataStart = 8 + headerLength;
    const dataLength = buffer.length - dataStart;
    const entries = new Map();

    for (const e of index.entries) {

        if (!e || !SHA.test(e.sha256) || !Number.isSafeInteger(e.size) || !Number.isSafeInteger(e.offset) || e.size < 0 || e.offset < 0 || e.offset + e.size > dataLength) {
            throw new Error("bundle : entrée invalide");
        }

        if (entries.has(e.sha256)) throw new Error("bundle : entrée en double");
        entries.set(e.sha256, { offset: dataStart + e.offset, size: e.size });
    }

    return entries;
}

/**
 * Extrait de bundleFile les contenus voulus vers stagingDir/<sha256>.dl, chacun vérifié (taille + SHA-256).
 * @param {string} bundleFile
 * @param {Array<{sha256:string, size:number}>} wanted
 * @param {string} stagingDir
 * @param {string} label  nom lisible (messages)
 * @returns {Promise<number>} nombre de fichiers extraits
 */
async function extractFromBundle(bundleFile, wanted, stagingDir, label = "lot de fichiers") {

    let buffer;
    let entries;

    try {
        buffer = await fsp.readFile(bundleFile);
        entries = parseBundle(buffer);
    } catch (error) {
        await fsp.rm(bundleFile, { force: true });         // illisible : sera retéléchargé à la prochaine tentative
        throw corruptError(label, error);
    }

    let count = 0;

    for (const want of wanted) {

        const entry = entries.get(want.sha256);
        const data = entry && entry.size === want.size ? buffer.subarray(entry.offset, entry.offset + entry.size) : null;

        if (!data || sha256(data) !== want.sha256) {
            await fsp.rm(bundleFile, { force: true });
            throw corruptError(label, new Error(`contenu ${want.sha256.slice(0, 8)} absent ou différent dans le bundle`));
        }

        const tmp = path.join(stagingDir, `${want.sha256}.part`);
        await fsp.writeFile(tmp, data);
        await renameRetry(tmp, path.join(stagingDir, `${want.sha256}.dl`));
        count++;
    }

    /* Le bundle a rendu ses fichiers (désormais dans .staging, chacun vérifié) : on libère la place. */
    await fsp.rm(bundleFile, { force: true });

    return count;
}

module.exports = { buildBundle, parseBundle, extractFromBundle, MAGIC, sha256 };
