#!/usr/bin/env node
"use strict";

/*
 * Publication d'une version du modpack CobbleRealm (outil administrateur).
 * Aucune dépendance externe.
 *
 *   node tools/publish.js <dossierSource> --version 5.2.0 [options]
 *   node tools/publish.js --check <manifest.json | https://...>
 *
 * Le script ne publie RIEN lui-même : il prépare le manifest et les fichiers
 * à envoyer (voir publish-out/UPLOAD.md), valide tout, puis archive le manifest
 * dans manifests/ pour permettre un retour arrière.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/* PUBLISH_REPO_ROOT : réservé aux tests (évite d'écrire dans le vrai dépôt). */
const REPO_ROOT = process.env.PUBLISH_REPO_ROOT
    ? path.resolve(process.env.PUBLISH_REPO_ROOT)
    : path.resolve(__dirname, "..");
const POLICIES = ["managed", "default", "preserved"];
const MAX_ASSET_BYTES = 2 * 1024 ** 3 - 1;      // limite GitHub : < 2 GiB par fichier
const ALLOWED_URL_HOSTS = ["github.com"];

/* ============================== chemins ============================== */

/* Mêmes règles que le launcher : une seule définition (updater/manifest.js). */
const { validateRelPath } = require("../updater/manifest.js");

function globToRegExp(pattern) {

    let out = "";

    for (let i = 0; i < pattern.length; i++) {

        const c = pattern[i];

        if (c === "*" && pattern[i + 1] === "*") {
            if (pattern[i + 2] === "/") { out += "(?:.*/)?"; i += 2; }
            else { out += ".*"; i += 1; }
        } else if (c === "*") out += "[^/]*";
        else if (c === "?") out += "[^/]";
        else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }

    return new RegExp(`^${out}$`, "i");
}

function compileRules(policy) {

    const compiled = [];

    for (const rule of policy.rules || []) {

        if (!POLICIES.includes(rule.policy)) {
            throw new Error(`policy.json : catégorie inconnue '${rule.policy}'`);
        }

        for (const pattern of rule.patterns || []) {
            compiled.push({ policy: rule.policy, pattern, regex: globToRegExp(pattern) });
        }
    }

    return compiled;
}

function classify(rel, compiled, fallback) {

    for (const rule of compiled) {
        if (rule.regex.test(rel)) return { policy: rule.policy, matched: rule.pattern };
    }

    return { policy: fallback, matched: null };
}

/* ============================== fichiers ============================== */

function walk(dir, base = "", out = [], skipped = []) {

    for (const entry of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {

        const rel = base ? `${base}/${entry.name}` : entry.name;

        if (entry.isSymbolicLink()) skipped.push(rel);
        else if (entry.isDirectory()) walk(dir, rel, out, skipped);
        else if (entry.isFile()) out.push({ rel, abs: path.join(dir, rel) });
    }

    return out;
}

function hashFile(abs) {

    return new Promise((resolve, reject) => {

        const hash = crypto.createHash("sha256");
        const stream = fs.createReadStream(abs);

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

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

/* Nom du fichier sur GitHub : le hash, donc identique = jamais renvoyé. */
function assetNameFor(sha256, rel) {

    const ext = path.extname(rel).toLowerCase().replace(/[^a-z0-9.]/g, "").slice(0, 12);
    return `${sha256}${ext}`;
}

/* ============================== versions & archives ============================== */

function parseVersion(v) {
    return /^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null;
}

function compareVersions(a, b) {

    const pa = parseVersion(a) || [0, 0, 0];
    const pb = parseVersion(b) || [0, 0, 0];

    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
    }

    return 0;
}

function loadArchivedManifests(manifestsDir) {

    const found = [];

    if (!fs.existsSync(manifestsDir)) return found;

    const scan = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) scan(full);
            else if (/^manifest-.+\.json$/.test(entry.name)) {
                try {
                    const manifest = JSON.parse(fs.readFileSync(full, "utf8"));
                    if (manifest && manifest.schema === 2) found.push({ file: full, manifest });
                } catch { /* archive illisible : ignorée */ }
            }
        }
    };

    scan(manifestsDir);
    return found;
}

/* ============================== construction ============================== */

/*
 * Calcule le manifest et la liste des fichiers à envoyer.
 * options : { sourceDir, policy, version, channel, manifestsDir, reuse, onProgress }
 */
async function buildManifest(options) {

    const {
        sourceDir, policy, version,
        channel = "stable",
        manifestsDir = path.join(REPO_ROOT, "manifests"),
        reuse = true,
        onProgress = () => {}
    } = options;

    const warnings = [];
    const compiled = compileRules(policy);
    const fallback = policy.fallbackPolicy || "default";

    if (!POLICIES.includes(fallback)) throw new Error(`fallbackPolicy invalide : ${fallback}`);

    /* 1. Parcours et classement */
    const skippedLinks = [];
    const all = walk(sourceDir, "", [], skippedLinks).sort((a, b) => a.rel.localeCompare(b.rel));

    if (skippedLinks.length) warnings.push(`${skippedLinks.length} lien(s) symbolique(s) ignoré(s)`);

    const toPublish = [];
    let preservedCount = 0;
    const unmatched = [];

    for (const file of all) {

        const { policy: category, matched } = classify(file.rel, compiled, fallback);

        if (category === "preserved") { preservedCount++; continue; }
        if (!matched) unmatched.push(file.rel);

        toPublish.push({ ...file, policy: category });
    }

    if (unmatched.length) {
        warnings.push(`${unmatched.length} fichier(s) sans règle (catégorie '${fallback}' appliquée) : ` +
            unmatched.slice(0, 5).join(", ") + (unmatched.length > 5 ? ", ..." : ""));
    }

    /* 2. Taille + SHA-256 */
    let done = 0;

    const hashed = await mapLimit(toPublish, 4, async (file) => {

        const size = fs.statSync(file.abs).size;
        const sha256 = await hashFile(file.abs);

        onProgress(++done, toPublish.length, file.rel);
        return { ...file, size, sha256 };
    });

    /* 3. Fichiers déjà en ligne (versions archivées) */
    const archives = loadArchivedManifests(manifestsDir);
    const knownUrls = new Map();

    if (reuse) {
        for (const { manifest } of archives) {
            for (const f of manifest.files) {
                knownUrls.set(decodeURIComponent(f.url.split("/").pop()), f.url);
            }
        }
    }

    /* 4. Répartition des nouveaux fichiers dans des releases (max 900 chacune) */
    const maxPerRelease = (policy.hosting && policy.hosting.maxAssetsPerRelease) || 900;
    const tagBase = `${(policy.hosting && policy.hosting.tagPrefix) || "pack-"}${channel === "stable" ? "" : channel + "-"}${version}`;
    const releaseBase = `https://github.com/${policy.hosting.repo}/releases/download`;

    const newAssets = new Map();      // assetName -> { assetName, abs, size, tag }
    const files = [];

    for (const file of hashed) {

        const assetName = assetNameFor(file.sha256, file.rel);
        let url = knownUrls.get(assetName);

        if (!url) {

            let asset = newAssets.get(assetName);

            if (!asset) {
                const index = Math.floor(newAssets.size / maxPerRelease);
                asset = {
                    assetName, abs: file.abs, size: file.size,
                    tag: index === 0 ? tagBase : `${tagBase}-${index + 1}`
                };
                newAssets.set(assetName, asset);
            }

            url = `${releaseBase}/${asset.tag}/${encodeURIComponent(assetName)}`;
        }

        files.push({ path: file.rel, size: file.size, sha256: file.sha256, url, policy: file.policy });
    }

    const manifest = {
        schema: 2,
        version,
        minecraft: options.minecraft || policy.minecraft,
        fabricLoader: options.fabricLoader || policy.fabricLoader,
        java: Number(options.java || policy.java),
        recommendedRamGb: Number(options.recommendedRamGb || policy.recommendedRamGb),
        published: new Date().toISOString(),
        strictDirs: policy.strictDirs || [],
        preserved: compiled.filter((r) => r.policy === "preserved").map((r) => r.pattern),
        files
    };

    return {
        manifest,
        newAssets: [...newAssets.values()],
        stats: { total: all.length, published: files.length, preserved: preservedCount },
        warnings,
        archives
    };
}

/* ============================== validation ============================== */

/* Retourne la liste des erreurs (vide = manifest publiable). */
function validateManifest(manifest, { allowEmptyMods = false } = {}) {

    const errors = [];
    const seen = new Set();

    if (manifest.schema !== 2) errors.push("schema doit valoir 2");
    if (!parseVersion(manifest.version)) errors.push(`version invalide '${manifest.version}' (attendu x.y.z)`);
    if (!manifest.minecraft) errors.push("minecraft manquant");
    if (!manifest.fabricLoader) errors.push("fabricLoader manquant");
    if (!Number.isInteger(manifest.java) || manifest.java < 8) errors.push("java invalide");
    if (!Number.isFinite(manifest.recommendedRamGb) || manifest.recommendedRamGb < 1) errors.push("recommendedRamGb invalide");
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
        errors.push("aucun fichier dans le manifest");
        return errors;
    }

    for (const f of manifest.files) {

        const pathError = validateRelPath(f.path);
        if (pathError) { errors.push(`${f.path} : ${pathError}`); continue; }

        const key = f.path.toLowerCase();         // Windows ne distingue pas la casse
        if (seen.has(key)) errors.push(`${f.path} : doublon`);
        seen.add(key);

        if (!/^[0-9a-f]{64}$/.test(f.sha256 || "")) errors.push(`${f.path} : sha256 invalide`);
        if (!Number.isInteger(f.size) || f.size < 0) errors.push(`${f.path} : taille invalide`);
        if (f.size > MAX_ASSET_BYTES) errors.push(`${f.path} : dépasse 2 Go (limite GitHub)`);
        if (!["managed", "default"].includes(f.policy)) errors.push(`${f.path} : catégorie '${f.policy}' invalide`);

        if (!f.url) errors.push(`${f.path} : URL manquante`);
        else {
            try {
                const url = new URL(f.url);
                if (url.protocol !== "https:") errors.push(`${f.path} : l'URL doit être en https`);
                if (!ALLOWED_URL_HOSTS.includes(url.hostname)) errors.push(`${f.path} : domaine non autorisé (${url.hostname})`);
                if (!url.pathname.includes("/releases/download/")) errors.push(`${f.path} : URL hors des GitHub Releases`);
            } catch {
                errors.push(`${f.path} : URL invalide`);
            }
        }
    }

    for (const dir of manifest.strictDirs || []) {

        const prefix = `${dir.toLowerCase()}/`;
        const count = manifest.files.filter((f) => f.path.toLowerCase().startsWith(prefix)).length;

        if (count === 0 && !allowEmptyMods) {
            errors.push(`'${dir}/' est vide dans le manifest : le mode strict retirerait TOUS les mods des joueurs ` +
                "(ajouter --allow-empty-mods si c'est voulu)");
        }
    }

    return errors;
}

/* Vérifie que chaque URL répond (GET d'1 octet). Retourne les URL en échec. */
async function checkUrls(manifest, fetchImpl = fetch) {

    const urls = [...new Set(manifest.files.map((f) => f.url))];
    const failures = [];

    await mapLimit(urls, 6, async (url) => {
        try {
            const response = await fetchImpl(url, { headers: { Range: "bytes=0-0" }, redirect: "follow" });
            if (response.status !== 200 && response.status !== 206) failures.push(`${url} -> HTTP ${response.status}`);
            if (response.body && response.body.cancel) await response.body.cancel().catch(() => {});
        } catch (error) {
            failures.push(`${url} -> ${error.message}`);
        }
    });

    return failures;
}

/* ============================== comparaison ============================== */

function summarizeChanges(previous, next) {

    const before = new Map((previous ? previous.files : []).map((f) => [f.path, f]));
    const after = new Map(next.files.map((f) => [f.path, f]));

    let added = 0, changed = 0, removed = 0, downloadBytes = 0;

    for (const [p, f] of after) {
        const old = before.get(p);
        if (!old) { added++; downloadBytes += f.size; }
        else if (old.sha256 !== f.sha256) { changed++; downloadBytes += f.size; }
    }

    for (const p of before.keys()) if (!after.has(p)) removed++;

    return { added, changed, removed, downloadBytes };
}

/* ============================== sorties ============================== */

function linkOrCopy(source, destination) {

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.rmSync(destination, { force: true });

    try { fs.linkSync(source, destination); }
    catch { fs.copyFileSync(source, destination); }
}

function writeUploadGuide(outDir, manifest, newAssets, policy, channel) {

    const tags = [...new Set(newAssets.map((a) => a.tag))];
    const repo = policy.hosting.repo;
    const pagesPath = channel === "stable" ? "docs/manifest.json" : `docs/${channel}/manifest.json`;

    let text = `# Publication de la version ${manifest.version}\n\n`;
    text += `## Étape 1 - Envoyer les fichiers sur GitHub Releases (dépôt ${repo})\n\n`;

    if (tags.length === 0) {
        text += "Aucun nouveau fichier à envoyer : tout est déjà en ligne.\n\n";
    }

    for (const tag of tags) {

        const count = newAssets.filter((a) => a.tag === tag).length;
        const prerelease = channel === "stable" ? "" : " (cocher « pre-release »)";

        text += `### Release \`${tag}\` - ${count} fichier(s)${prerelease}\n\n`;
        text += `1. https://github.com/${repo}/releases/new\n`;
        text += `2. Tag : \`${tag}\` (Create new tag on publish) - titre libre.\n`;
        text += `3. Glisser-déposer TOUT le contenu du dossier \`release-${tag}\` dans la zone « Attach binaries ».\n`;
        text += "4. Attendre la fin des envois, puis « Publish release ».\n\n";
        text += "Avec le CLI `gh` (si installé), en PowerShell :\n\n";
        text += "```powershell\n";
        text += `gh release create ${tag} --repo ${repo} --title "${tag}" --notes "Modpack ${manifest.version}"` +
            `${channel === "stable" ? "" : " --prerelease"} (Get-ChildItem "release-${tag}").FullName\n`;
        text += "```\n\n";
    }

    text += "## Étape 2 - Vérifier que tout est en ligne\n\n";
    text += "```\nnode tools/publish.js --check publish-out/" + pagesPath + "\n```\n\n";
    text += "Ne passez à l'étape 3 que si le résultat est « Toutes les URL répondent ».\n\n";
    text += "## Étape 3 - Publier le manifest (GitHub Pages)\n\n";
    text += `Copier \`publish-out/${pagesPath}\` vers \`${pagesPath}\` du dépôt, commit, push. `;
    text += "Les launchers voient la nouvelle version après 1 à 2 minutes.\n\n";
    text += "## Retour arrière\n\n";
    text += "Remettre dans `" + pagesPath + "` un ancien manifest de `manifests/`. Les anciens fichiers restent en ligne.\n";

    fs.writeFileSync(path.join(outDir, "UPLOAD.md"), text, "utf8");
}

/* ============================== ligne de commande ============================== */

function parseArgs(argv) {

    const args = { _: [] };

    for (let i = 0; i < argv.length; i++) {

        const a = argv[i];

        if (a.startsWith("--")) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith("--")) { args[key] = next; i++; }
            else args[key] = true;
        } else args._.push(a);
    }

    return args;
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} Mo`;

async function runCheck(target) {

    let manifest;

    if (/^https?:\/\//.test(target)) manifest = await (await fetch(`${target}?t=${Date.now()}`)).json();
    else manifest = JSON.parse(fs.readFileSync(target, "utf8"));

    const errors = validateManifest(manifest);

    if (errors.length) {
        console.error("Manifest invalide :\n - " + errors.join("\n - "));
        return 1;
    }

    console.log(`Manifest ${manifest.version} valide (${manifest.files.length} fichiers). Vérification des URL...`);

    const failures = await checkUrls(manifest);

    if (failures.length) {
        console.error(`${failures.length} URL ne répondent pas :\n - ` + failures.slice(0, 20).join("\n - "));
        return 1;
    }

    console.log("Toutes les URL répondent.");
    return 0;
}

async function main(argv) {

    const args = parseArgs(argv);

    if (args.check) return runCheck(args.check === true ? args._[0] : args.check);

    const sourceDir = args._[0] && path.resolve(args._[0]);

    if (!sourceDir || !args.version) {
        console.error("Usage : node tools/publish.js <dossierSource> --version x.y.z " +
            "[--channel beta] [--out publish-out] [--dry-run] [--write-docs] [--check-urls] " +
            "[--no-reuse] [--allow-empty-mods] [--force]\n" +
            "        node tools/publish.js --check <manifest.json | URL>");
        return 2;
    }

    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
        console.error(`Dossier source introuvable : ${sourceDir}`);
        return 2;
    }

    const policy = JSON.parse(fs.readFileSync(path.join(__dirname, "policy.json"), "utf8"));
    const channel = typeof args.channel === "string" ? args.channel : "stable";
    const outDir = path.resolve(typeof args.out === "string" ? args.out : path.join(REPO_ROOT, "publish-out"));

    if (!/^[a-z0-9-]+$/.test(channel)) { console.error("Canal invalide (a-z, 0-9, -)"); return 2; }
    if (!parseVersion(args.version)) { console.error("La version doit être au format x.y.z"); return 2; }

    /* Garde-fou : ne jamais écrire dans le dossier source */
    if (outDir === sourceDir || outDir.startsWith(sourceDir + path.sep)) {
        console.error("Le dossier de sortie ne doit pas être dans le dossier source.");
        return 2;
    }

    const manifestsDir = path.join(REPO_ROOT, "manifests", channel === "stable" ? "" : channel);

    console.log(`Analyse de ${sourceDir} ...`);

    const result = await buildManifest({
        sourceDir, policy, version: args.version, channel,
        manifestsDir: path.join(REPO_ROOT, "manifests"),
        reuse: !args["no-reuse"],
        minecraft: args.minecraft, fabricLoader: args["fabric-loader"],
        java: args.java, recommendedRamGb: args.ram,
        onProgress: (n, total) => { if (n % 25 === 0 || n === total) process.stdout.write(`\r  hash ${n}/${total}`); }
    });

    console.log("");

    const { manifest, newAssets, stats, warnings, archives } = result;

    const errors = validateManifest(manifest, { allowEmptyMods: !!args["allow-empty-mods"] });

    /* Même version déjà archivée avec un contenu différent : refus */
    const sameVersion = archives.find((a) => a.manifest.version === manifest.version &&
        path.dirname(a.file) === manifestsDir.replace(/[\\/]$/, ""));

    if (sameVersion && !args.force) {
        const sameFiles = JSON.stringify(sameVersion.manifest.files.map((f) => [f.path, f.sha256])) ===
            JSON.stringify(manifest.files.map((f) => [f.path, f.sha256]));
        if (!sameFiles) errors.push(`la version ${manifest.version} existe déjà avec un contenu différent (changer de version, ou --force)`);
    }

    if (errors.length) {
        console.error("Publication refusée :\n - " + errors.join("\n - "));
        return 1;
    }

    /* Résumé par rapport à la dernière version archivée du même canal */
    const sameChannel = archives
        .filter((a) => path.dirname(a.file) === manifestsDir.replace(/[\\/]$/, ""))
        .sort((a, b) => compareVersions(a.manifest.version, b.manifest.version));
    const previous = sameChannel.length ? sameChannel[sameChannel.length - 1].manifest : null;
    const changes = summarizeChanges(previous, manifest);

    console.log(`Version ${manifest.version} : ${stats.published} fichiers publiés, ${stats.preserved} préservés (non publiés).`);
    console.log(previous
        ? `Par rapport à la ${previous.version} : +${changes.added} ajoutés, ~${changes.changed} modifiés, -${changes.removed} retirés. ` +
          `Un joueur à jour téléchargera ${mb(changes.downloadBytes)}.`
        : `Première publication : un joueur sans installation téléchargera ${mb(changes.downloadBytes)}.`);
    console.log(`Nouveaux fichiers à envoyer : ${newAssets.length} (${mb(newAssets.reduce((s, a) => s + a.size, 0))}).`);
    for (const w of warnings) console.warn(`Attention : ${w}`);

    if (args["dry-run"]) { console.log("Simulation (--dry-run) : rien n'a été écrit."); return 0; }

    /* Écriture des sorties */
    const pagesRel = channel === "stable" ? path.join("docs", "manifest.json") : path.join("docs", channel, "manifest.json");
    const manifestText = JSON.stringify(manifest, null, 2) + "\n";

    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(outDir, path.dirname(pagesRel)), { recursive: true });
    fs.writeFileSync(path.join(outDir, pagesRel), manifestText, "utf8");

    for (const asset of newAssets) linkOrCopy(asset.abs, path.join(outDir, `release-${asset.tag}`, asset.assetName));

    writeUploadGuide(outDir, manifest, newAssets, policy, channel);

    fs.mkdirSync(manifestsDir, { recursive: true });
    fs.writeFileSync(path.join(manifestsDir, `manifest-${manifest.version}.json`), manifestText, "utf8");

    if (args["write-docs"]) {
        const target = path.join(REPO_ROOT, pagesRel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, manifestText, "utf8");
        console.log(`Manifest copié dans ${pagesRel}`);
    }

    console.log(`Prêt : ${outDir}\nSuivre les étapes de ${path.join(outDir, "UPLOAD.md")}`);

    if (args["check-urls"]) return runCheck(path.join(outDir, pagesRel));

    return 0;
}

module.exports = {
    validateRelPath, globToRegExp, classify, compileRules, assetNameFor,
    buildManifest, validateManifest, checkUrls, summarizeChanges, compareVersions, hashFile
};

if (require.main === module) {
    main(process.argv.slice(2)).then(
        (code) => process.exit(code),
        (error) => { console.error("Erreur :", error.message); process.exit(1); }
    );
}
