#!/usr/bin/env node
"use strict";

/*
 * Build fiable de l'installeur (outil administrateur).
 *
 *   node tools/build.js [--publish] [options electron-builder...]
 *
 * Pourquoi : sous Windows, l'antivirus (Defender) ou l'indexeur analyse les fichiers que electron-builder vient
 * d'écrire et les verrouille un instant. Le renommage « win-unpacked.tmp » → « win-unpacked » échoue alors par
 * intermittence avec EPERM / EBUSY, alors que le code n'a aucun défaut. Ce script :
 *   1. nettoie les résidus d'une tentative précédente (dossiers *.tmp du dossier de sortie) ;
 *   2. relance le build, avec une pause croissante, si (et seulement si) l'échec est de cette famille ;
 *   3. s'arrête tout de suite sur toute autre erreur (une vraie erreur ne doit jamais être masquée).
 * Il ne signe rien, ne publie rien (sauf --publish explicite) et n'écrit que dans le dossier de sortie.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ATTEMPTS = 4;
const TRANSIENT = /EPERM|EBUSY|EACCES|ENOTEMPTY|operation not permitted|being used by another process|utilisé par un autre processus/i;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function outputDir(args) {

    const flag = args.find((a) => a.startsWith("--config.directories.output="));
    const dir = flag ? flag.split("=")[1] : "dist";

    return path.resolve(ROOT, dir);
}

/* Supprime uniquement les dossiers temporaires laissés par electron-builder (jamais l'installeur déjà produit). */
function cleanLeftovers(dir) {

    if (!fs.existsSync(dir)) return;

    for (const name of fs.readdirSync(dir)) {

        if (/\.tmp$/i.test(name) || name === "win-unpacked") {
            try { fs.rmSync(path.join(dir, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* sera réessayé */ }
        }
    }
}

function run(args) {

    const cli = require.resolve("electron-builder/cli.js", { paths: [ROOT] });
    const result = spawnSync(process.execPath, [cli, "--win", ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");

    return { status: result.status === null ? 1 : result.status, text: `${result.stdout || ""}\n${result.stderr || ""}` };
}

function main() {

    const argv = process.argv.slice(2);
    const publish = argv.includes("--publish");
    const args = argv.filter((a) => a !== "--publish");

    if (publish) args.push("--publish", "always");

    const out = outputDir(args);

    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {

        cleanLeftovers(out);

        const result = run(args);

        if (result.status === 0) {
            console.log(attempt > 1 ? `\nBuild réussi (tentative ${attempt}/${ATTEMPTS}, après un blocage passager de l'antivirus).` : "\nBuild réussi.");
            return 0;
        }

        if (!TRANSIENT.test(result.text)) {
            console.error("\nÉchec du build (erreur qui n'est pas un blocage passager) : voir le message ci-dessus.");
            return result.status;
        }

        if (attempt === ATTEMPTS) break;

        const wait = attempt * 4000;
        console.warn(`\nBlocage passager d'un fichier (antivirus ?). Nouvelle tentative ${attempt + 1}/${ATTEMPTS} dans ${wait / 1000} s...`);
        sleep(wait);
    }

    console.error(`\nÉchec du build après ${ATTEMPTS} tentatives : fichier verrouillé en permanence.\n` +
        "Ajoute le dossier du projet (ou du dossier de sortie) aux exclusions de Windows Defender, puis relance.");

    return 1;
}

if (require.main === module) process.exit(main());

module.exports = { TRANSIENT, outputDir };
