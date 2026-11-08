"use strict";

/*
 * Téléchargements parallèles vers .staging/ (jamais en mémoire).
 *  - écriture en flux dans <sha256>.part, reprise via l'en-tête Range ;
 *  - taille + SHA-256 vérifiés avant d'accepter le fichier (<sha256>.dl) ;
 *  - 3 essais avec délai croissant ;
 *  - un fichier déjà vérifié (.dl) n'est jamais retéléchargé : la reprise après
 *    coupure ou crash repart donc là où elle s'était arrêtée.
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { request } = require("./http");
const { FILE_HOSTS } = require("./manifest");
const { mapLimit, sleep, renameRetry } = require("./util");
const { UpdateError, toUpdateError, corruptError, diskFullError, missingRemoteError } = require("./errors");

function freeSpaceBytes(dir) {
    try {
        const s = fs.statfsSync(dir);
        return s.bavail * s.bsize;
    } catch {
        return Infinity;       // impossible de savoir : on ne bloque pas
    }
}

/*
 * Progression : vitesse sur une fenêtre glissante de 3 s et temps restant estimé.
 * Les octets déjà présents (reprise) comptent dans l'avancement mais PAS dans la vitesse,
 * sinon le temps restant serait faussé.
 */
function createProgress({ bytesTotal, filesTotal, onProgress, now = Date.now }) {

    const samples = [];
    let bytesDone = 0;       // avancement total (reprise comprise)
    let realDone = 0;        // octets réellement reçus pendant cette exécution
    let filesDone = 0;
    let lastEmit = 0;
    let startedAt = null;
    const active = new Set();

    const snapshot = () => {

        const t = now();
        while (samples.length && t - samples[0].t > 3000) samples.shift();

        const first = samples[0];
        const speed = first && t > first.t ? ((realDone - first.bytes) / (t - first.t)) * 1000 : 0;

        /* Estimation affichée seulement quand elle est fiable : 3 s de téléchargement et une vitesse non nulle. */
        const reliable = startedAt !== null && t - startedAt >= 3000 && speed > 0;
        const remaining = Math.max(0, bytesTotal - bytesDone);

        return {
            step: "download",
            file: [...active][0] || "",
            filesDone, filesTotal, bytesDone, bytesTotal,
            percent: bytesTotal > 0 ? Math.min(100, Math.floor((bytesDone / bytesTotal) * 100)) : 100,
            speed: Math.max(0, Math.round(speed)),
            etaSeconds: remaining === 0 ? 0 : (reliable ? Math.ceil(remaining / speed) : null)
        };
    };

    return {
        add(bytes) {
            const t = now();
            if (startedAt === null) startedAt = t;
            bytesDone += bytes;
            realDone += bytes;
            samples.push({ t, bytes: realDone });
            if (t - lastEmit >= 150) { lastEmit = t; onProgress(snapshot()); }
        },
        addFree(bytes) { bytesDone += bytes; },
        rewind(bytes) { bytesDone = Math.max(0, bytesDone - bytes); },
        start(label) { active.add(label); },
        finish(label, count = 1) { active.delete(label); filesDone += count; onProgress(snapshot()); },
        snapshot
    };
}

async function fileSize(file) {
    try { return (await fsp.stat(file)).size; } catch { return -1; }
}

async function downloadOne(item, ctx) {

    const { stagingDir, retries, retryDelayMs, timeoutMs, allowLocal, progress, signal } = ctx;
    const finalPath = path.join(stagingDir, `${item.sha256}.dl`);
    const partPath = path.join(stagingDir, `${item.sha256}.part`);

    /* Déjà téléchargé et vérifié lors d'une exécution précédente. */
    if (await fileSize(finalPath) === item.size) {
        progress.addFree(item.size);
        progress.start(item.label);
        progress.finish(item.label, item.fileCount || 1);
        return;
    }

    progress.start(item.label);

    let lastError = null;
    let countedBytes = 0;          // octets déjà ajoutés à la progression pour ce fichier
    let restarts = 0;

    for (let attempt = 0; attempt < retries; attempt++) {

        if (signal && signal.aborted) throw new UpdateError("ABORTED", "La mise à jour a été interrompue.");
        if (attempt > 0) await sleep(retryDelayMs * 2 ** (attempt - 1));

        try {

            const hash = crypto.createHash("sha256");
            let offset = await fileSize(partPath);

            if (offset > item.size) { await fsp.rm(partPath, { force: true }); offset = -1; }

            /* On réintègre dans le hash les octets déjà reçus. */
            if (offset > 0) {
                for await (const chunk of fs.createReadStream(partPath)) hash.update(chunk);
            } else offset = 0;

            if (offset !== countedBytes) { progress.rewind(countedBytes); progress.addFree(offset); countedBytes = offset; }

            if (offset < item.size) {

                const response = await request(item.url, {
                    headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
                    timeoutMs, allowLocal, allowedHosts: FILE_HOSTS, signal
                });

                if (response.statusCode === 200 && offset > 0) {
                    /* Le serveur ignore Range : on repart de zéro au prochain tour. */
                    progress.rewind(countedBytes); countedBytes = 0;
                    await fsp.rm(partPath, { force: true });
                    response.destroy();
                    throw Object.assign(new Error("Range ignoré"), { restart: true });
                }

                const handle = await fsp.open(partPath, offset > 0 ? "a" : "w");
                let received = offset;

                try {
                    for await (const chunk of response) {
                        received += chunk.length;
                        if (received > item.size) throw Object.assign(new Error("fichier plus gros que prévu"), { corrupt: true });
                        hash.update(chunk);
                        await handle.write(chunk);
                        countedBytes += chunk.length;
                        progress.add(chunk.length);
                    }
                } finally {
                    await handle.close();
                }

                if (received !== item.size) {
                    throw Object.assign(new Error("téléchargement incomplet"), { code: "ECONNRESET" });
                }
            }

            /* Fichier vide (taille 0) : rien à télécharger, mais le fichier doit exister pour être vérifié puis déplacé. */
            if (item.size === 0) await fsp.writeFile(partPath, "");

            const digest = hash.digest("hex");

            if (digest !== item.sha256) {
                await fsp.rm(partPath, { force: true });
                progress.rewind(countedBytes); countedBytes = 0;
                throw Object.assign(new Error("hash différent"), { corrupt: true });
            }

            await renameRetry(partPath, finalPath);
            progress.finish(item.label, item.fileCount || 1);
            return;

        } catch (error) {

            /* Range ignoré : ne compte pas comme un essai, mais au plus 3 fois (pas de boucle infinie). */
            if (error.restart && ++restarts <= 3) { lastError = error; attempt--; continue; }

            if (error.httpStatus === 404 || error.httpStatus === 410) throw missingRemoteError(item.label);
            if (error.httpStatus === 416) { await fsp.rm(partPath, { force: true }); lastError = error; continue; }

            const converted = toUpdateError(error);

            /* Erreurs qui ne se règlent pas en réessayant. */
            if (["DISK_FULL", "FORBIDDEN_HOST", "ABORTED", "FILE_LOCKED"].includes(converted.code)) throw converted;

            lastError = error.corrupt ? Object.assign(error, { corrupt: true }) : converted;
        }
    }

    if (lastError && lastError.corrupt) throw corruptError(item.label, lastError);

    throw lastError instanceof UpdateError ? lastError : toUpdateError(lastError);
}

/**
 * @param {Array<{sha256,size,url,label,fileCount?}>} items   (fileCount : nombre de fichiers que couvre un bundle)
 * @returns {Promise<void>} résout quand tous les fichiers sont vérifiés dans stagingDir
 */
async function downloadAll(items, {
    stagingDir, concurrency = 5, retries = 3, retryDelayMs = 1000, timeoutMs = 30000,
    allowLocal = false, onProgress = () => {}, signal = null, freeSpace = freeSpaceBytes
}) {

    await fsp.mkdir(stagingDir, { recursive: true });

    /* Espace disque : ce qui reste à télécharger + marge de sécurité. */
    let remaining = 0;

    for (const item of items) {
        const done = await fileSize(path.join(stagingDir, `${item.sha256}.dl`)) === item.size ? item.size : Math.max(0, await fileSize(path.join(stagingDir, `${item.sha256}.part`)));
        remaining += item.size - done;
    }

    const margin = 256 * 1024 * 1024;

    if (remaining > 0 && freeSpace(stagingDir) < remaining + margin) throw diskFullError(remaining + margin);

    const bytesTotal = items.reduce((sum, i) => sum + i.size, 0);
    const progress = createProgress({ bytesTotal, filesTotal: items.reduce((sum, i) => sum + (i.fileCount || 1), 0), onProgress });
    const controller = new AbortController();

    if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

    const ctx = { stagingDir, retries, retryDelayMs, timeoutMs, allowLocal, progress, signal: controller.signal };

    try {
        await mapLimit(items, Math.min(Math.max(concurrency, 1), 6), async (item) => {
            try { await downloadOne(item, ctx); }
            catch (error) { controller.abort(); throw error; }      // un échec arrête les autres
        });
    } catch (error) {
        throw toUpdateError(error);
    }

    onProgress(progress.snapshot());
}

module.exports = { downloadAll, downloadOne, createProgress, freeSpaceBytes };
