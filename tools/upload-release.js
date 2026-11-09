#!/usr/bin/env node
"use strict";

/*
 * Envoie les fichiers d'un dossier release-<tag> (produit par publish.js) vers une release GitHub, de façon fiable
 * (outil administrateur ; nécessite le CLI GitHub « gh » déjà connecté : gh auth login).
 *
 *   node tools/upload-release.js <dossier release-...> --tag pack-files-1 --repo cyrian290606/CobbleRealm-Pack [--create] [--dry-run] [--batch 20]
 *
 * Pourquoi un outil : 690 fichiers ne passent pas dans une seule commande Windows (limite de longueur) et un envoi
 * interrompu doit pouvoir REPRENDRE sans tout renvoyer. L'outil :
 *   - ne renvoie jamais un fichier déjà présent avec la bonne taille (reprise possible à volonté) ;
 *   - envoie par petits lots, avec 3 essais et pause croissante (GitHub limite parfois le débit) ;
 *   - vérifie à la fin que chaque fichier est en ligne avec la taille attendue ;
 *   - ne supprime et n'écrase JAMAIS rien sur GitHub.
 * Rien n'est envoyé avec --dry-run.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const command = () => (process.env.GH_COMMAND ? JSON.parse(process.env.GH_COMMAND) : ["gh"]);       // GH_COMMAND : réservé aux tests
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function gh(args, { allowFailure = false } = {}) {

    const cmd = command();
    const result = spawnSync(cmd[0], [...cmd.slice(1), ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

    if (result.error) throw new Error("Le CLI GitHub (gh) est introuvable. Installe-le (https://cli.github.com) puis lance : gh auth login");
    if (result.status !== 0 && !allowFailure) throw new Error(`gh ${args.slice(0, 3).join(" ")} : ${(result.stderr || result.stdout).trim().slice(0, 400)}`);

    return result;
}

function remoteAssets(tag, repo) {

    const result = gh(["release", "view", tag, "--repo", repo, "--json", "assets"], { allowFailure: true });

    if (result.status !== 0) return null;                    // release absente

    return new Map(JSON.parse(result.stdout).assets.map((a) => [a.name, a.size]));
}

function uploadRelease({ dir, tag, repo, create = false, dryRun = false, batch = 20, log = console.log }) {

    const files = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => ({ name: e.name, abs: path.join(dir, e.name), size: fs.statSync(path.join(dir, e.name)).size }));

    if (!files.length) throw new Error(`${dir} est vide.`);

    let remote = remoteAssets(tag, repo);

    if (remote === null) {
        if (!create) throw new Error(`La release « ${tag} » n'existe pas sur ${repo}. Ajoute --create pour la créer (ou crée-la sur GitHub).`);
        log(`Création de la release « ${tag} »...`);
        if (!dryRun) { gh(["release", "create", tag, "--repo", repo, "--title", tag, "--notes", "Fichiers du modpack CobbleRealm. Ne rien supprimer : les anciennes versions et les retours arrière en ont besoin."]); }
        remote = new Map();
    }

    const todo = files.filter((f) => remote.get(f.name) !== f.size);
    const different = files.filter((f) => remote.has(f.name) && remote.get(f.name) !== f.size);

    if (different.length) throw new Error(`${different.length} fichier(s) existent déjà en ligne avec une AUTRE taille (ex. ${different[0].name}) : arrêt, je n'écrase jamais rien. Vérifie la release.`);

    log(`${files.length} fichier(s) dans le dossier, ${files.length - todo.length} déjà en ligne, ${todo.length} à envoyer${dryRun ? " (simulation : rien n'est envoyé)" : ""}.`);

    let sent = 0;

    for (let i = 0; i < todo.length && !dryRun; i += batch) {

        const group = todo.slice(i, i + batch);

        for (let attempt = 1; ; attempt++) {

            const result = gh(["release", "upload", tag, "--repo", repo, ...group.map((f) => f.abs)], { allowFailure: true });

            if (result.status === 0) break;

            if (attempt >= 3) throw new Error(`Échec de l'envoi après 3 essais : ${(result.stderr || "").trim().slice(0, 300)}\nRelance la même commande : les fichiers déjà envoyés ne sont pas renvoyés.`);

            log(`  essai ${attempt} échoué, nouvelle tentative...`);
            sleep(attempt * (Number(process.env.UPLOAD_RETRY_MS) || 5000));          // UPLOAD_RETRY_MS : réservé aux tests
        }

        sent += group.length;
        log(`  ${Math.min(i + batch, todo.length)}/${todo.length} envoyés`);
    }

    if (dryRun) return { total: files.length, sent: 0, missing: todo.length };

    /* vérification finale : tout est en ligne avec la bonne taille */
    const after = remoteAssets(tag, repo) || new Map();
    const missing = files.filter((f) => after.get(f.name) !== f.size);

    if (missing.length) throw new Error(`${missing.length} fichier(s) absents ou incomplets en ligne après l'envoi (ex. ${missing[0].name}). Relance la commande.`);

    log(`OK : ${files.length} fichier(s) en ligne sur « ${tag} », tailles vérifiées.`);

    return { total: files.length, sent, missing: 0 };
}

if (require.main === module) {

    const argv = process.argv.slice(2);
    const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
    const dir = argv.find((a) => !a.startsWith("--") && a !== opt("tag") && a !== opt("repo") && a !== opt("batch"));

    if (!dir || !opt("tag") || !opt("repo")) {
        console.error("Usage : node tools/upload-release.js <dossier release-...> --tag pack-files-1 --repo cyrian290606/CobbleRealm-Pack [--create] [--dry-run] [--batch 20]");
        process.exit(2);
    }

    try {
        uploadRelease({ dir: path.resolve(dir), tag: opt("tag"), repo: opt("repo"), create: argv.includes("--create"), dryRun: argv.includes("--dry-run"), batch: Number(opt("batch") || 20) });
    } catch (error) {
        console.error("Erreur :", error.message);
        process.exit(1);
    }
}

module.exports = { uploadRelease };
