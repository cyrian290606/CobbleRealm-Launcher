"use strict";

const fs = require("fs");
const crypto = require("crypto");

function hashFile(filePath) {

    return new Promise((resolve, reject) => {

        const hash = crypto.createHash("sha256");
        const stream = fs.createReadStream(filePath);

        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("error", reject);
        stream.on("end", () => resolve(hash.digest("hex")));
    });
}

async function mapLimit(items, limit, fn) {

    const results = new Array(items.length);
    let next = 0;

    async function worker() {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    }

    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
    return results;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * Renommage résistant : sous Windows, un antivirus ou l'indexation peut verrouiller un fichier ou un dossier
 * pendant quelques centaines de millisecondes juste après sa création (EPERM / EBUSY / EACCES).
 * On réessaie quelques fois avant d'abandonner : l'installation n'échoue plus pour si peu.
 */
const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);
const RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1200, 1500];

function pause(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameRetrySync(from, to, { fsImpl = fs, delays = RETRY_DELAYS_MS, wait = pause } = {}) {

    for (let attempt = 0; ; attempt++) {

        try {
            return fsImpl.renameSync(from, to);
        } catch (error) {
            if (!TRANSIENT.has(error.code) || attempt >= delays.length) throw error;
            wait(delays[attempt]);
        }
    }
}

async function renameRetry(from, to, { fsImpl = fs.promises, delays = RETRY_DELAYS_MS } = {}) {

    for (let attempt = 0; ; attempt++) {

        try {
            return await fsImpl.rename(from, to);
        } catch (error) {
            if (!TRANSIENT.has(error.code) || attempt >= delays.length) throw error;
            await sleep(delays[attempt]);
        }
    }
}

/*
 * Contenu « normalisé » d'un fichier .properties : sans les lignes de commentaire, sans les espaces de fin
 * et avec les lignes triées. Java réécrit ces fichiers à chaque démarrage du jeu en changeant seulement la ligne
 * de date (« #Sun Nov 08 21:53:03 CET 2026 ») : le contenu utile est identique.
 * Le tri n'est appliqué que s'il n'y a aucune ligne continuée par « \\ » (le sens dépendrait de l'ordre).
 */
const NORMALIZABLE = /\.properties$/i;
const NORMALIZABLE_MAX_BYTES = 1024 * 1024;

function normalizedPropertiesHash(buffer) {

    const lines = buffer.toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/)
        .map((line) => line.replace(/\s+$/, ""))
        .filter((line) => line !== "" && !/^\s*[#!]/.test(line));

    if (!lines.some((line) => line.endsWith("\\"))) lines.sort();

    return crypto.createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

module.exports = { hashFile, mapLimit, sleep, renameRetrySync, renameRetry, normalizedPropertiesHash, NORMALIZABLE, NORMALIZABLE_MAX_BYTES };
