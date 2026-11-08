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

module.exports = { hashFile, mapLimit, sleep, renameRetrySync, renameRetry };
