"use strict";

/*
 * Orchestrateur de mise à jour du modpack.
 *
 *   const updater = createUpdater({ gameRoot, manifestUrl, onProgress });
 *   await updater.check();                 // lit le manifest (1 seule fois par session) et calcule le plan
 *   await updater.sync();                  // télécharge + applique
 *   await updater.repair();                // idem, mais revérifie TOUS les fichiers
 *
 * Le jeu ne doit démarrer que si sync()/repair() ont réussi (ok === true).
 */

const fs = require("fs");
const path = require("path");
const { fetchManifest } = require("./manifest");
const { buildPlan } = require("./diff");
const { downloadAll } = require("./download");
const { applyPlan, purgeRemoved } = require("./apply");
const { readLock } = require("./lock");
const { extractFromBundle } = require("./bundle");
const { UpdateError, toUpdateError, mo, cancelledError } = require("./errors");

const STAGING = ".staging";

function createUpdater({
    gameRoot, manifestUrl, onProgress = () => {}, allowLocal = false,
    fetchOptions = {}, downloadOptions = {}, hooks = {}, now = () => Date.now(), onDiagnostic = () => {},
    /* Signature Ed25519 du manifest : obligatoire. false = tests / mode développement uniquement (jamais dans l'application installée). */
    requireSignature = true, trustedKeys = null
}) {

    const stagingDir = path.join(gameRoot, STAGING);
    const hashCache = new Map();
    let manifestPromise = null;
    let manifestLoaded = false;     // vrai dès que le manifest a pu être lu au moins une fois
    let running = null;
    let currentRun = null;          // { controller, phase: "scan" | "download" | "apply" }

    const emit = (event) => { try { onProgress(event); } catch { /* l'interface ne doit jamais casser la mise à jour */ } };

    /* Le manifest n'est téléchargé qu'une fois par session (sauf échec ou force). */
    function getManifest({ force = false } = {}) {

        if (force) manifestPromise = null;

        if (!manifestPromise) {
            manifestPromise = fetchManifest(manifestUrl, { allowLocal, requireSignature, trustedKeys, ...fetchOptions })
                .then((manifest) => { manifestLoaded = true; return manifest; })
                .catch((error) => { manifestPromise = null; throw error; });
        }

        return manifestPromise;
    }

    function installedInfo() {
        const { lock, valid } = readLock(gameRoot);
        return { valid, version: lock ? lock.version : null, lock };
    }

    async function makePlan(manifest, { repair, signal = null }) {

        emit({ step: "scan", message: "Vérification des fichiers...", percent: 0 });

        const { lock } = installedInfo();

        const plan = await buildPlan({
            manifest, gameRoot, lock, repair, hashCache, signal,
            onScan: (done, total) => emit({ step: "scan", message: "Vérification des fichiers...", percent: Math.floor((done / total) * 100) })
        });

        emit({
            step: "plan",
            filesToDownload: plan.uniqueDownloads.length,
            bytesToDownload: plan.bytesToDownload,
            message: plan.uniqueDownloads.length
                ? `${plan.uniqueDownloads.length} fichier${plan.uniqueDownloads.length > 1 ? "s" : ""} à télécharger (${mo(plan.bytesToDownload)})`
                : "Aucun fichier à télécharger"
        });

        return plan;
    }

    /**
     * Lecture seule : que faudrait-il faire ? Si le manifest est injoignable, renvoie offline: true.
     */
    async function check() {

        const installed = installedInfo();

        try {
            const manifest = await getManifest();
            const plan = await makePlan(manifest, { repair: false });

            return {
                ok: true, offline: false, manifest,
                installedVersion: installed.version, remoteVersion: manifest.version, valid: installed.valid,
                updateAvailable: !plan.isEmpty || !installed.valid || installed.version !== manifest.version,
                filesToDownload: plan.uniqueDownloads.length, bytesToDownload: plan.bytesToDownload
            };

        } catch (error) {

            const converted = toUpdateError(error);

            if (["OFFLINE", "SERVER"].includes(converted.code)) {
                return {
                    ok: false, offline: true, error: converted,
                    installedVersion: installed.version, remoteVersion: null,
                    valid: installed.valid, updateAvailable: false
                };
            }

            throw converted;
        }
    }

    /*
     * Télécharge ce que le plan demande : fichiers individuels et bundles, puis extrait les fichiers des bundles
     * vers .staging/<sha256>.dl (chacun vérifié). À partir de là, l'installation est identique pour tous les fichiers.
     * Reprise : un contenu déjà extrait n'exige pas de retélécharger son bundle.
     */
    async function fetchPlanFiles(plan, signal) {

        const stagedOk = (item) => { try { return fs.statSync(path.join(stagingDir, `${item.sha256}.dl`)).size === item.size; } catch { return false; } };
        const bundles = [];

        for (const bundle of plan.bundles) {
            const missing = bundle.contents.filter((c) => !stagedOk(c));
            if (missing.length) bundles.push({ ...bundle, contents: missing, fileCount: missing.length });
        }

        await downloadAll([...bundles, ...plan.directDownloads], { stagingDir, allowLocal, onProgress: emit, signal, ...downloadOptions });

        for (const bundle of bundles) {
            await extractFromBundle(path.join(stagingDir, `${bundle.sha256}.dl`), bundle.contents, stagingDir, bundle.label);
        }
    }

    async function runSync({ repair }) {

        const controller = new AbortController();
        currentRun = { controller, phase: "scan" };

        try {

            const manifest = await getManifest();
            const installed = installedInfo();
            const plan = await makePlan(manifest, { repair, signal: controller.signal });

            try { onDiagnostic({ repair, version: manifest.version, installedVersion: installed.version, entries: plan.diagnostic }); } catch { /* le journal ne doit jamais casser la mise à jour */ }

            const mustWriteLock = !plan.isEmpty || plan.adopted.length > 0 || !installed.valid || installed.version !== manifest.version;

            if (!mustWriteLock) {
                purgeRemoved(gameRoot, { now: now() });
                emit({ step: "done", percent: 100, message: "CobbleRealm est à jour" });
                return { ok: true, offline: false, version: manifest.version, downloaded: 0, bytes: 0, quarantined: [] };
            }

            if (plan.uniqueDownloads.length) {
                currentRun.phase = "download";
                await fetchPlanFiles(plan, controller.signal);
            }

            /* À partir d'ici l'installation des fichiers a commencé : on ne peut plus annuler. */
            currentRun.phase = "apply";

            emit({ step: "apply", percent: 100, message: "Installation..." });

            const result = applyPlan({ plan, manifest, gameRoot, stagingDir, hooks, now: now(), onProgress: emit });

            emit({ step: "done", percent: 100, message: "CobbleRealm est à jour" });

            return {
                ok: true, offline: false, version: manifest.version,
                downloaded: plan.uniqueDownloads.length, bytes: plan.bytesToDownload, quarantined: result.quarantined
            };

        } catch (error) {

            /* Annulation demandée par le joueur : ce n'est pas un échec (fichiers déjà vérifiés conservés). */
            if (controller.signal.aborted && currentRun && currentRun.phase !== "apply") throw cancelledError();

            throw error;

        } finally {

            currentRun = null;
        }
    }

    /**
     * Annule la mise à jour en cours (avant l'installation des fichiers).
     * Les fichiers déjà téléchargés et vérifiés sont conservés : la reprise repart de là.
     */
    function cancel() {

        if (!currentRun) {
            return { cancelled: false, reason: "none" };
        }

        if (currentRun.phase === "apply") {
            return { cancelled: false, reason: "installing" };
        }

        currentRun.controller.abort();

        return { cancelled: true };
    }

    /**
     * Synchronise l'installation avec le manifest.
     * Si le manifest est injoignable mais qu'une installation valide existe : { ok: true, offline: true }.
     */
    function sync({ repair = false } = {}) {

        if (running) return running;

        running = (async () => {

            try {
                return await runSync({ repair });

            } catch (error) {

                const converted = toUpdateError(error);
                const installed = installedInfo();

                /* Hors-ligne autorisé seulement si le manifest n'a jamais pu être lu :
                   une panne en plein téléchargement laisse une mise à jour incomplète, donc pas de jeu. */
                if (installed.valid && ["OFFLINE", "SERVER"].includes(converted.code) && !manifestLoaded) {
                    return { ok: true, offline: true, version: installed.version, warning: converted.message };
                }

                throw converted;

            } finally {
                running = null;
            }
        })();

        return running;
    }

    return {
        getManifest,
        check, sync, cancel,
        repair: () => sync({ repair: true }),
        status: installedInfo,
        stagingDir
    };
}

module.exports = { createUpdater, UpdateError };
