#!/usr/bin/env node
"use strict";

/*
 * Prépare EN LOCAL le dépôt CobbleRealm-Pack (outil administrateur).
 *
 *   node tools/pack-prepare.js <dossier>
 *
 * Crée <dossier> (nouveau ou vide) à partir du modèle tools/pack-repo/ : README, .gitattributes (aucune conversion de
 * fin de ligne : la signature porte sur les octets exacts), .gitignore, docs/.nojekyll. Initialise un dépôt Git LOCAL
 * (branche main, un premier commit). N'ajoute AUCUN dépôt distant, ne se connecte pas à GitHub, ne publie rien.
 * Le dossier ne doit pas être dans le dépôt du launcher.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const TEMPLATE = path.join(__dirname, "pack-repo");

function git(cwd, ...args) {

    const result = spawnSync("git", args, { cwd, encoding: "utf8" });

    if (result.error) throw new Error("git est introuvable : installe Git pour Windows (https://git-scm.com).");
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} : ${(result.stderr || result.stdout).trim()}`);

    return result.stdout.trim();
}

/* Copie récursive simple, fichier par fichier (fs.cpSync a fait quitter Node brutalement sur ce disque). */
function copyTemplate(from, to) {

    fs.mkdirSync(to, { recursive: true });

    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const source = path.join(from, entry.name);
        const target = path.join(to, entry.name);
        if (entry.isDirectory()) copyTemplate(source, target);
        else fs.copyFileSync(source, target);
    }
}

function preparePack(target) {

    const dir = path.resolve(target);
    const rel = path.relative(REPO_ROOT, dir);

    if (!rel.startsWith("..") && !path.isAbsolute(rel)) throw new Error("Le dépôt Pack ne doit pas être dans le dépôt du launcher.");
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} n'est pas vide : je ne touche à aucun dossier existant.`);

    fs.mkdirSync(dir, { recursive: true });
    copyTemplate(TEMPLATE, dir);
    fs.mkdirSync(path.join(dir, "manifests"), { recursive: true });
    fs.writeFileSync(path.join(dir, "manifests", ".gitkeep"), "");

    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "core.autocrlf", "false");
    git(dir, "config", "core.safecrlf", "false");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "Structure initiale du depot de distribution");

    return { dir, branch: git(dir, "branch", "--show-current"), remotes: git(dir, "remote") };
}

if (require.main === module) {

    const target = process.argv[2];

    if (!target) {
        console.error("Usage : node tools/pack-prepare.js <dossier du futur dépôt CobbleRealm-Pack>");
        process.exit(2);
    }

    try {
        const result = preparePack(target);
        console.log(`Dépôt local prêt : ${result.dir} (branche ${result.branch}, aucun dépôt distant).`);
        console.log("Rien n'a été publié. Suite : tools/GITHUB-SETUP.md");
    } catch (error) {
        console.error("Erreur :", error.message);
        process.exit(1);
    }
}

module.exports = { preparePack };
