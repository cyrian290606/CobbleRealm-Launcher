"use strict";

/*
 * Applique une mise à jour : déplace les fichiers vérifiés vers leur destination,
 * met en quarantaine (.removed/) les fichiers retirés, puis écrit lock.json
 * EN DERNIER. Rien n'est jamais supprimé définitivement ici, sauf le contenu
 * de .removed/ plus ancien que la durée de rétention.
 */

const fs = require("fs");
const path = require("path");
const { resolveInside } = require("./manifest");
const { beginUpdate, commitLock } = require("./lock");
const { toUpdateError } = require("./errors");

const REMOVED_DIR = ".removed";
const RETENTION_DAYS = 30;

function statRecord(abs, rel, sha256, policy) {

    const st = fs.statSync(abs);
    return { path: rel, sha256, size: st.size, mtimeMs: Math.floor(st.mtimeMs), policy };
}

function moveToQuarantine(gameRoot, rel, stamp) {

    const source = resolveInside(gameRoot, rel);
    let target = path.join(gameRoot, REMOVED_DIR, stamp, ...rel.split("/"));

    fs.mkdirSync(path.dirname(target), { recursive: true });

    if (fs.existsSync(target)) target = `${target}.${Date.now()}`;

    fs.renameSync(source, target);
}

/* Supprime de .removed/ les sauvegardes plus vieilles que `days` jours. Rien d'autre n'est touché. */
function purgeRemoved(gameRoot, { days = RETENTION_DAYS, now = Date.now() } = {}) {

    const base = path.join(gameRoot, REMOVED_DIR);
    const purged = [];

    let entries;
    try { entries = fs.readdirSync(base, { withFileTypes: true }); }
    catch { return purged; }

    for (const entry of entries) {

        if (!entry.isDirectory()) continue;

        const dir = path.join(base, entry.name);

        try {
            if (now - fs.statSync(dir).mtimeMs > days * 86400000) {
                fs.rmSync(dir, { recursive: true, force: true });
                purged.push(entry.name);
            }
        } catch { /* on laisse tel quel */ }
    }

    return purged;
}

/**
 * @param {object} p
 * @param {object} p.plan      résultat de buildPlan
 * @param {object} p.manifest
 * @param {string} p.gameRoot
 * @param {string} p.stagingDir
 * @param {object} [p.hooks]   { afterFile(n) } : réservé aux tests (simulation de crash)
 */
function applyPlan({ plan, manifest, gameRoot, stagingDir, hooks = {}, now = Date.now(), onProgress = () => {} }) {

    try {

        /* À partir d'ici, l'installation n'est plus considérée comme valide jusqu'à la fin. */
        beginUpdate(gameRoot);

        const records = {};

        for (const { record, file } of plan.unchanged) records[file.path] = { sha256: record.sha256, size: record.size, mtimeMs: record.mtimeMs, policy: file.policy };
        for (const a of plan.adopted) records[a.path] = { sha256: a.sha256, size: a.size, mtimeMs: a.mtimeMs, policy: a.policy };

        const policyByPath = new Map(manifest.files.map((f) => [f.path, f.policy]));
        let count = 0;

        for (const item of plan.uniqueDownloads) {

            const staged = path.join(stagingDir, `${item.sha256}.dl`);
            const [first, ...others] = item.paths;
            const firstDest = resolveInside(gameRoot, first);

            fs.mkdirSync(path.dirname(firstDest), { recursive: true });
            fs.rmSync(firstDest, { force: true });
            fs.renameSync(staged, firstDest);

            const rec = statRecord(firstDest, first, item.sha256, policyByPath.get(first));
            records[first] = { sha256: rec.sha256, size: rec.size, mtimeMs: rec.mtimeMs, policy: rec.policy };

            for (const other of others) {
                const dest = resolveInside(gameRoot, other);
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.rmSync(dest, { force: true });
                fs.copyFileSync(firstDest, dest);
                const r = statRecord(dest, other, item.sha256, policyByPath.get(other));
                records[other] = { sha256: r.sha256, size: r.size, mtimeMs: r.mtimeMs, policy: r.policy };
            }

            count++;
            onProgress({ step: "apply", filesDone: count, filesTotal: plan.uniqueDownloads.length, message: "Installation..." });
            if (hooks.afterFile) hooks.afterFile(count);
        }

        const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
        const quarantined = [];

        for (const rel of [...plan.toRemove, ...plan.strictRemovals, ...(plan.explicitRemovals || [])]) {
            try {
                moveToQuarantine(gameRoot, rel, stamp);
                quarantined.push(rel);
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
            }
        }

        commitLock(gameRoot, {
            schema: 1,
            version: manifest.version,
            minecraft: manifest.minecraft,
            fabricLoader: manifest.fabricLoader,
            java: manifest.java,
            recommendedRamGb: manifest.recommendedRamGb,
            installedAt: new Date(now).toISOString(),
            files: records
        });

        fs.rmSync(stagingDir, { recursive: true, force: true });
        const purged = purgeRemoved(gameRoot, { now });

        return { installed: count, quarantined, purged };

    } catch (error) {
        throw toUpdateError(error);
    }
}

module.exports = { applyPlan, purgeRemoved, moveToQuarantine, REMOVED_DIR, RETENTION_DAYS };
