#!/usr/bin/env node
"use strict";

/*
 * Contrôle AVANT / APRÈS la publication officielle du launcher (outil administrateur, LECTURE SEULE : ne publie, ne modifie
 * ni ne supprime rien, n'écrit rien sur GitHub).
 *
 *   node tools/preflight.js            avant la publication : tout est-il prêt et cohérent ?
 *   node tools/preflight.js --after    après la publication : est-ce bien en ligne et fonctionnel ?
 *
 * Nécessite le CLI GitHub (gh auth login). Chemin de gh : variable GH, sinon « gh » dans le PATH, sinon l'emplacement standard Windows.
 * Affiche une ligne PASS / FAIL par vérification ; code de sortie 1 s'il y a au moins un FAIL.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const REPO = "cyrian290606/CobbleRealm-Launcher";
const PACK = "cyrian290606/CobbleRealm-Pack";
const PAGES = "https://cyrian290606.github.io/CobbleRealm-Pack/manifest.json";
const after = process.argv.includes("--after");

const GH = process.env.GH || (spawnSync("gh", ["--version"]).error ? "C:/Program Files/GitHub CLI/gh.exe" : "gh");
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };
const run = (cmd, args, options = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28, ...options });
const git = (...args) => run("git", args).stdout.trim();
const gh = (...args) => run(GH, args);
const ghJson = (...args) => { const r = gh(...args); if (r.status !== 0) throw new Error(String(r.stderr).split("\n")[0]); return JSON.parse(r.stdout); };
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sha512b64 = (file) => crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64");

async function main() {

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const version = pkg.version;
    const tag = `v${version}`;
    const dist = path.join(ROOT, "dist");

    console.log(`\nContrôle ${after ? "APRÈS" : "AVANT"} publication — launcher ${version} (${tag})\n`);

    /* ---------- code ---------- */
    console.log("Code");
    const branch = git("branch", "--show-current");
    const dirty = git("status", "--short").split("\n").filter((l) => l && !l.includes("mods-maison"));
    check("branche de travail « developpe »", branch === "developpe", branch);
    check("aucune modification non enregistrée (hors mods-maison)", dirty.length === 0, dirty.join(" | ").slice(0, 120));
    check("CHANGELOG.md contient la section de cette version", new RegExp(`^## Version ${version.replace(/\./g, "\\.")}\\b`, "m").test(fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8")));
    const keys = require("./keys");
    check("aucune clé privée dans le dépôt", keys.findPrivateKeysInRepo().length === 0);
    const trusted = JSON.parse(fs.readFileSync(path.join(ROOT, "updater", "trusted-keys.json"), "utf8"));
    check("clé principale ET clé de secours intégrées au launcher", trusted.keys.some((k) => k.role === "primary") && trusted.keys.some((k) => k.role === "backup") && !(trusted.revoked || []).length, trusted.keys.map((k) => k.id).join(", "));

    /* ---------- installeur local ---------- */
    console.log("\nInstalleur construit (dossier dist/)");
    const files = { exe: path.join(dist, "CobbleRealm-Launcher-Setup.exe"), blockmap: path.join(dist, "CobbleRealm-Launcher-Setup.exe.blockmap"), yml: path.join(dist, "latest.yml") };
    const present = Object.values(files).every((f) => fs.existsSync(f));
    check("installeur, blockmap et latest.yml présents", present);
    let yml = "";
    if (present) {
        yml = fs.readFileSync(files.yml, "utf8");
        check("latest.yml annonce la version du package.json", new RegExp(`^version: ${version.replace(/\./g, "\\.")}$`, "m").test(yml));
        check("latest.yml : empreinte SHA-512 = celle de l'installeur", yml.includes(sha512b64(files.exe)));
        check("latest.yml : taille = celle de l'installeur", yml.includes(`size: ${fs.statSync(files.exe).size}`));
        const asar = require(path.join(ROOT, "node_modules", "@electron", "asar"));
        const embedded = JSON.parse(asar.extractFile(path.join(dist, "win-unpacked", "resources", "app.asar"), "package.json").toString("utf8"));
        check("l'application contenue dans l'installeur est en version " + version, embedded.version === version, embedded.version);
        const debug = fs.existsSync(path.join(dist, "builder-debug.yml")) ? fs.readFileSync(path.join(dist, "builder-debug.yml"), "utf8") : "";
        check("assistant d'installation français uniquement", /MUI_LANGUAGE "French"/.test(debug) && (debug.match(/MUI_LANGUAGE/g) || []).length === 1);
    }

    /* ---------- GitHub : launcher ---------- */
    console.log("\nGitHub : dépôt du launcher");
    const releases = ghJson("api", `repos/${REPO}/releases?per_page=50`);
    const mine = releases.filter((r) => r.tag_name === tag);
    const latest = ghJson("api", `repos/${REPO}/releases/latest`);

    if (!after) {
        check("un seul brouillon « " + tag + " »", mine.length === 1 && mine[0].draft === true, `${mine.length} release(s), brouillon : ${mine[0] && mine[0].draft}`);
        const release = mine[0];
        if (release && present) {
            const names = release.assets.map((a) => a.name).sort();
            check("le brouillon contient exactement l'installeur, le blockmap et latest.yml", JSON.stringify(names) === JSON.stringify(["CobbleRealm-Launcher-Setup.exe", "CobbleRealm-Launcher-Setup.exe.blockmap", "latest.yml"]), names.join(", "));
            const digest = (n) => ((release.assets.find((a) => a.name === n) || {}).digest || "").replace("sha256:", "");
            check("installeur en ligne = installeur local (SHA-256)", digest("CobbleRealm-Launcher-Setup.exe") === sha256(files.exe));
            check("blockmap en ligne = blockmap local (SHA-256)", digest("CobbleRealm-Launcher-Setup.exe.blockmap") === sha256(files.blockmap));
            check("latest.yml en ligne = latest.yml local (SHA-256)", digest("latest.yml") === sha256(files.yml));
            check("le brouillon n'est pas une pre-release", release.prerelease === false);
            check("titre et notes renseignés", Boolean(release.name) && String(release.body || "").length > 200);
        }
        check("la release « Latest » actuelle n'est PAS encore " + tag + " (rien n'est publié)", latest.tag_name !== tag, "Latest actuelle : " + latest.tag_name);
        const draftsPublic = (await fetch(`https://github.com/${REPO}/releases/tag/${tag}`)).status;
        check("la release est invisible du public (HTTP 404)", draftsPublic === 404, "HTTP " + draftsPublic);
    } else {
        check("la release « Latest » est " + tag, latest.tag_name === tag, "Latest : " + latest.tag_name);
        check("elle n'est ni un brouillon ni une pre-release", !latest.draft && !latest.prerelease);
        const res = await fetch(`https://github.com/${REPO}/releases/latest/download/latest.yml`, { redirect: "follow" });
        const text = res.ok ? await res.text() : "";
        check("latest.yml public lisible et à la bonne version (c'est ce que lit la mise à jour automatique)", res.ok && new RegExp(`^version: ${version.replace(/\./g, "\\.")}$`, "m").test(text), "HTTP " + res.status);
        if (present) {
            check("latest.yml public = latest.yml local", text === fs.readFileSync(files.yml, "utf8"));
            const exe = await fetch(`https://github.com/${REPO}/releases/latest/download/CobbleRealm-Launcher-Setup.exe`, { redirect: "follow" });
            const hash = crypto.createHash("sha256"); let bytes = 0;
            if (exe.ok) for await (const chunk of exe.body) { hash.update(chunk); bytes += chunk.length; }
            check("installeur téléchargé depuis le lien public « releases/latest » : SHA-256 identique au fichier testé", exe.ok && hash.digest("hex") === sha256(files.exe), `${(bytes / 1048576).toFixed(1)} Mo, HTTP ${exe.status}`);
        }
    }
    const old = releases.filter((r) => r.tag_name !== tag);
    check("aucune autre release plus récente que " + tag + " (elle resterait « Latest » sinon)", after ? latest.tag_name === tag : true, `${old.length} anciennes releases (modpack v5 à v10, anciens installeurs 1.0.x)`);

    /* ---------- GitHub : modpack ---------- */
    console.log("\nGitHub : modpack (CobbleRealm-Pack)");
    const { verifyManifestSignature, loadTrustedKeys } = require("../updater/signature");
    const manifestRes = await fetch(`${PAGES}?t=${Date.now()}`, { headers: { "Accept-Encoding": "gzip" } });
    const bytes = Buffer.from(await manifestRes.arrayBuffer());
    const sigRes = await fetch(`${PAGES}.sig?t=${Date.now()}`);
    let signed = null;
    try { signed = verifyManifestSignature(bytes, await sigRes.json(), loadTrustedKeys()); } catch (e) { signed = null; }
    check("manifest du modpack en ligne (GitHub Pages) et signature valide avec les clés du launcher", manifestRes.ok && Boolean(signed), signed ? `clé ${signed.keyId} (${signed.role})` : `HTTP ${manifestRes.status}`);
    let manifest = null;
    try { manifest = JSON.parse(bytes.toString("utf8")); } catch { /* illisible */ }
    if (manifest) {
        const names = new Set([...manifest.files.filter((f) => f.url).map((f) => f.url), ...manifest.bundles.map((b) => b.url)].map((u) => decodeURIComponent(u.split("/").pop())));
        const tags = new Set([...manifest.files.filter((f) => f.url).map((f) => f.url), ...manifest.bundles.map((b) => b.url)].map((u) => u.split("/")[7]));
        let online = new Set();
        for (const t of tags) { const rel = ghJson("api", `repos/${PACK}/releases/tags/${t}`); const assets = JSON.parse(gh("api", "--paginate", `repos/${PACK}/releases/${rel.id}/assets?per_page=100`, "--jq", "[.[] | .name]").stdout.replace(/\]\s*\[/g, ",") || "[]"); assets.forEach((a) => online.add(a)); }
        const missing = [...names].filter((n) => !online.has(n));
        check("tous les fichiers du modpack cités par le manifest sont en ligne", missing.length === 0, `${names.size} fichiers attendus, ${missing.length} absents`);
    }
    const mainSha = git("rev-parse", "origin/main").slice(0, 10);
    check("branche main de GitHub : ancien manifest toujours en place pour les launchers 1.0.x", (() => { try { return JSON.parse(git("show", "origin/main:manifest.json")).version !== undefined && !JSON.parse(git("show", "origin/main:manifest.json")).schema; } catch { return false; } })(), "origin/main = " + mainSha + (after ? " (comparer avec le commit de fusion)" : " (non modifiée)"));

    const failed = results.filter((r) => !r).length;
    console.log(failed ? `\n${failed} contrôle(s) en ÉCHEC : ne pas publier avant de les avoir résolus.` : `\nTous les contrôles passent (${results.length}).`);
    return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (error) => { console.error("Erreur :", error.message); process.exit(2); });
