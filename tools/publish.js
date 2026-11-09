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

/* --pack <dossier> : dépôt local CobbleRealm-Pack (docs/, manifests/, publish-out/ y sont écrits). Doit être lu AVANT REPO_ROOT. */
if (require.main === module) {
    const packIndex = process.argv.indexOf("--pack");
    if (packIndex >= 0 && process.argv[packIndex + 1] && !process.argv[packIndex + 1].startsWith("--")) process.env.PUBLISH_REPO_ROOT = process.argv[packIndex + 1];
}

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
const { normalizedPropertiesHash, NORMALIZABLE, NORMALIZABLE_MAX_BYTES } = require("../updater/util.js");
const { buildBundle, sha256: sha256Of } = require("../updater/bundle.js");
const { planBundles, DEFAULTS: BUNDLE_DEFAULTS } = require("./bundling.js");

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

        /* .properties : hash du contenu utile (voir updater/util.js), pour ne pas retélécharger un fichier que le jeu a seulement redaté. */
        const nsha256 = NORMALIZABLE.test(file.rel) && size <= NORMALIZABLE_MAX_BYTES
            ? normalizedPropertiesHash(fs.readFileSync(file.abs))
            : undefined;

        onProgress(++done, toPublish.length, file.rel);
        return { ...file, size, sha256, nsha256 };
    });

    /* 3. Fichiers déjà en ligne (versions archivées).
          --force remplace une préparation de la MÊME version : son archive ne prouve pas que ses fichiers sont en ligne
          (elle peut n'avoir jamais été envoyée) : on ne s'y fie donc pas, tout ce qu'il faut envoyer est préparé. */
    const archives = loadArchivedManifests(manifestsDir).filter((a) => !(options.replaceVersion && a.manifest.version === options.replaceVersion));
    const assetUrls = (manifest) => [...manifest.files.filter((f) => f.url).map((f) => f.url), ...(manifest.bundles || []).map((b) => b.url)];
    const nameOfUrl = (url) => decodeURIComponent(url.split("/").pop());
    const knownUrls = new Map();

    if (reuse) {
        for (const { manifest } of archives) {
            for (const url of assetUrls(manifest)) knownUrls.set(nameOfUrl(url), url);
        }
    }

    /* 4. Bundles : les petits fichiers sont regroupés en lots (tools/bundling.js, updater/bundle.js) */
    const smallLimit = options.smallFileBytes === undefined ? BUNDLE_DEFAULTS.smallBytes : options.smallFileBytes;
    const bundleOf = new Map();           // sha256 d'un contenu -> id du bundle
    const bundles = [];                   // { id, size, assetName, data }

    if (options.bundles !== false) {

        const contents = new Map();

        for (const file of hashed) {
            if (file.size > smallLimit) continue;
            const c = contents.get(file.sha256) || { sha256: file.sha256, size: file.size, paths: [], abs: file.abs };
            c.paths.push(file.rel);
            contents.set(file.sha256, c);
        }

        for (const planned of planBundles([...contents.values()], { ...options.bundleOptions, smallBytes: smallLimit })) {

            const entries = planned.shas.map((sha) => {
                const c = contents.get(sha);
                const data = fs.readFileSync(c.abs);
                if (data.length !== c.size || sha256Of(data) !== sha) throw new Error(`${c.paths[0]} a changé pendant la préparation : relance la publication`);
                return { sha256: sha, data };
            });

            const data = buildBundle(entries);
            const id = sha256Of(data);

            bundles.push({ id, size: data.length, assetName: `${id}.crb`, data });
            for (const sha of planned.shas) bundleOf.set(sha, id);
        }
    }

    /* 5. Répartition des NOUVEAUX fichiers dans la release « ouverte » (max 900 fichiers par release GitHub) :
          on remplit d'abord la dernière release existante, puis on en ouvre une nouvelle. */
    const maxPerRelease = (policy.hosting && policy.hosting.maxAssetsPerRelease) || 900;
    const tagStem = `${(policy.hosting && policy.hosting.tagPrefix) || "pack-"}${channel === "stable" ? "" : channel + "-"}files`;
    const releaseBase = `https://github.com/${policy.hosting.repo}/releases/download`;

    const existingByTag = new Map();      // tag -> Set(nom de fichier)

    for (const { manifest } of archives) {
        for (const url of assetUrls(manifest)) {
            const m = new RegExp(`/releases/download/(${tagStem}-\\d+)/([^/]+)$`).exec(url);
            if (!m) continue;
            if (!existingByTag.has(m[1])) existingByTag.set(m[1], new Set());
            existingByTag.get(m[1]).add(decodeURIComponent(m[2]));
        }
    }

    let openIndex = Math.max(1, ...[...existingByTag.keys()].map((t) => Number(t.slice(tagStem.length + 1))));
    const countIn = (tag) => (existingByTag.get(tag) ? existingByTag.get(tag).size : 0) + [...newAssetsByTag(tag)].length;
    const newAssets = new Map();          // nom de fichier -> { assetName, abs | data, size, tag }

    function newAssetsByTag(tag) { return [...newAssets.values()].filter((a) => a.tag === tag); }

    const addAsset = (assetName, source, size) => {

        let asset = newAssets.get(assetName);

        if (!asset) {
            while (countIn(`${tagStem}-${openIndex}`) >= maxPerRelease) openIndex++;
            asset = { assetName, ...source, size, tag: `${tagStem}-${openIndex}` };
            newAssets.set(assetName, asset);
        }

        return `${releaseBase}/${asset.tag}/${encodeURIComponent(assetName)}`;
    };

    const bundleEntries = [];

    for (const bundle of bundles.sort((a, b) => (a.id < b.id ? -1 : 1))) {
        const url = knownUrls.get(bundle.assetName) || addAsset(bundle.assetName, { data: bundle.data }, bundle.size);
        bundleEntries.push({ id: bundle.id, size: bundle.size, url });
    }

    const files = [];

    for (const file of hashed) {

        const nsha = file.nsha256 ? { nsha256: file.nsha256 } : {};

        if (bundleOf.has(file.sha256) && file.size <= smallLimit) {
            files.push({ path: file.rel, size: file.size, sha256: file.sha256, ...nsha, bundle: bundleOf.get(file.sha256), policy: file.policy });
            continue;
        }

        const assetName = assetNameFor(file.sha256, file.rel);
        const url = knownUrls.get(assetName) || addAsset(assetName, { abs: file.abs }, file.size);

        files.push({ path: file.rel, size: file.size, sha256: file.sha256, ...nsha, url, policy: file.policy });
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
        remove: policy.remove || [],
        preserved: compiled.filter((r) => r.policy === "preserved").map((r) => r.pattern),
        ...(bundleEntries.length ? { bundles: bundleEntries } : {}),
        files
    };

    return {
        manifest,
        newAssets: [...newAssets.values()],
        stats: { total: all.length, published: files.length, preserved: preservedCount, bundled: files.filter((f) => f.bundle).length, bundles: bundleEntries.length },
        existingTags: [...existingByTag.keys()],
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

    const checkAssetUrl = (label, urlText) => {
        try {
            const url = new URL(urlText);
            if (url.protocol !== "https:") errors.push(`${label} : l'URL doit être en https`);
            if (!ALLOWED_URL_HOSTS.includes(url.hostname)) errors.push(`${label} : domaine non autorisé (${url.hostname})`);
            if (!url.pathname.includes("/releases/download/")) errors.push(`${label} : URL hors des GitHub Releases`);
        } catch {
            errors.push(`${label} : URL invalide`);
        }
    };

    const bundleIds = new Set();

    for (const b of manifest.bundles || []) {
        if (!/^[0-9a-f]{64}$/.test(b.id || "")) errors.push("bundle : id invalide");
        if (!Number.isInteger(b.size) || b.size <= 0 || b.size > 64 * 1024 * 1024) errors.push(`bundle ${String(b.id).slice(0, 8)} : taille invalide`);
        if (bundleIds.has(b.id)) errors.push(`bundle ${String(b.id).slice(0, 8)} : doublon`);
        bundleIds.add(b.id);
        checkAssetUrl(`bundle ${String(b.id).slice(0, 8)}`, b.url);
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

        if (f.bundle !== undefined) {
            if (!bundleIds.has(f.bundle)) errors.push(`${f.path} : bundle inconnu`);
            if (f.url !== undefined) errors.push(`${f.path} : un fichier d'un bundle n'a pas d'URL`);
        } else if (!f.url) errors.push(`${f.path} : URL manquante`);
        else checkAssetUrl(f.path, f.url);
    }

    for (const rel of manifest.remove || []) {

        const problem = validateRelPath(rel);
        if (problem) errors.push(`remove : ${rel} : ${problem}`);
        else if (seen.has(rel.toLowerCase())) errors.push(`remove : ${rel} est aussi publié dans les fichiers`);
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

    const urls = [...new Set([...manifest.files.map((f) => f.url), ...(manifest.bundles || []).map((b) => b.url)].filter(Boolean))];
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
    const bundleSize = new Map((next.bundles || []).map((b) => [b.id, b.size]));
    const neededBundles = new Set();
    const need = (f) => { if (f.bundle) neededBundles.add(f.bundle); else downloadBytes += f.size; };

    for (const [p, f] of after) {
        const old = before.get(p);
        if (!old) { added++; need(f); }
        else if (old.sha256 !== f.sha256) { changed++; need(f); }
    }

    /* un fichier d'un bundle oblige à télécharger le bundle entier */
    for (const id of neededBundles) downloadBytes += bundleSize.get(id) || 0;

    for (const p of before.keys()) if (!after.has(p)) removed++;

    return { added, changed, removed, downloadBytes };
}

/* ============================== sorties ============================== */

/*
 * Copie (jamais de lien physique) : avec un lien, modifier un fichier du dossier source APRÈS la préparation altérait
 * aussi le fichier à envoyer, dont le nom (SHA-256) ne correspondait alors plus à son contenu.
 * COPYFILE_FICLONE : copie « instantanée » sans occuper d'espace quand le disque le permet (ReFS, APFS...), sinon copie normale.
 */
function linkOrCopy(source, destination) {

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.rmSync(destination, { force: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE);
}

function writeUploadGuide(outDir, manifest, newAssets, policy, channel, existingTags = []) {

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

        const exists = existingTags.includes(tag);

        text += `### Release \`${tag}\` - ${count} fichier(s) à ${exists ? "AJOUTER à la release existante" : "envoyer (nouvelle release)"}${prerelease}\n\n`;
        text += "Avec le CLI GitHub (`gh auth login` une seule fois), depuis le dossier du dépôt launcher :\n\n```powershell\n";
        text += `node tools/upload-release.js "${path.join(outDir, `release-${tag}`)}" --tag ${tag} --repo ${repo}${exists ? "" : " --create"}\n`;
        text += "```\n\n";
        text += "L'outil envoie par lots, **reprend là où il s'est arrêté** si tu le relances, ne renvoie jamais un fichier déjà en ligne, n'écrase et ne supprime rien, et vérifie les tailles à la fin. " +
            "Ne supprime jamais de fichier d'une release : les anciennes versions du modpack en ont besoin.\n\n";
    }

    text += "## Étape 2 - Vérifier que tout est en ligne et que la signature est valide\n\n";
    text += "```powershell\nnode tools/publish.js --check \"" + path.join(outDir, pagesPath) + "\"\n```\n\n";
    text += "Ne passe à l'étape 3 que si le résultat est « Signature valide » puis « Toutes les URL répondent ».\n\n";
    text += "## Étape 3 - Publier le manifest (GitHub Pages)\n\n";
    text += `Le manifest ET sa signature doivent partir ensemble : \`${pagesPath}\` et \`${pagesPath}.sig\` (sans signature, les launchers refusent le manifest). ` +
        "Avec `--write-docs` ils sont déjà copiés dans `docs/` du dépôt Pack : fais `git add docs manifests`, `git commit`, `git push`. ";
    text += "Les launchers voient la nouvelle version après 1 à 2 minutes. Contrôle ensuite la version EN LIGNE : `node tools/publish.js --check https://cyrian290606.github.io/CobbleRealm-Pack/manifest.json --signature-only`.\n\n";
    text += "## Retour arrière\n\n";
    text += "Remettre dans `" + pagesPath + "` un ancien `manifests/manifest-X.json` ET son `.sig` (renommés manifest.json et manifest.json.sig). Les anciens fichiers restent en ligne.\n";

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

/* Vérifie la signature du manifest (octets exacts) avec les clés de confiance du launcher. Retourne un message d'erreur ou null. */
async function checkSignature(target) {

    const { verifyManifestSignature, loadTrustedKeys } = require("../updater/signature.js");
    let bytes, sig = null;

    if (/^https?:\/\//.test(target)) {
        bytes = Buffer.from(await (await fetch(`${target}?t=${Date.now()}`)).arrayBuffer());
        const response = await fetch(`${target}.sig?t=${Date.now()}`);
        if (response.ok) { try { sig = await response.json(); } catch { sig = null; } }
    } else {
        bytes = fs.readFileSync(target);
        try { sig = JSON.parse(fs.readFileSync(`${target}.sig`, "utf8")); } catch { sig = null; }
    }

    try {
        const result = verifyManifestSignature(bytes, sig, loadTrustedKeys(process.env.COBBLEREALM_TRUST_FILE || undefined));
        console.log(`Signature valide (clé ${result.keyId}, ${result.role}).`);
        return null;
    } catch (error) {
        return `SIGNATURE REFUSÉE : ${error.message}`;
    }
}

async function runCheck(target, { signatureOnly = false } = {}) {

    const signatureProblem = await checkSignature(target);

    if (signatureProblem) { console.error(signatureProblem + "\nLes launchers refuseraient ce manifest."); return 1; }
    if (signatureOnly) return 0;

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

    if (args.check) return runCheck(args.check === true ? args._[0] : args.check, { signatureOnly: !!args["signature-only"] });

    const sourceDir = args._[0] && path.resolve(args._[0]);

    if (!sourceDir || !args.version) {
        console.error("Usage : node tools/publish.js <dossierSource> --version x.y.z " +
            "[--channel beta] [--out publish-out] [--dry-run] [--write-docs] [--check-urls] " +
            "[--no-reuse] [--no-bundles] [--allow-empty-mods] [--force] [--sign <clé.key.json>]\n" +
            "        node tools/publish.js --check <manifest.json | URL> [--signature-only]\n" +
            "        (--pack <dossier du dépôt CobbleRealm-Pack> : y écrit docs/, manifests/ et publish-out/)");
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
        bundles: !args["no-bundles"],
        replaceVersion: args.force ? args.version : null,
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
    if (stats.bundles) console.log(`Petits fichiers : ${stats.bundled} regroupés dans ${stats.bundles} bundle(s) ; ${stats.published - stats.bundled} fichier(s) individuel(s).`);
    for (const w of warnings) console.warn(`Attention : ${w}`);

    if (args["dry-run"]) { console.log("Simulation (--dry-run) : rien n'a été écrit."); return 0; }

    /* Écriture des sorties */
    const pagesRel = channel === "stable" ? path.join("docs", "manifest.json") : path.join("docs", channel, "manifest.json");
    const manifestText = JSON.stringify(manifest, null, 2) + "\n";

    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(outDir, path.dirname(pagesRel)), { recursive: true });
    fs.writeFileSync(path.join(outDir, pagesRel), manifestText, "utf8");

    /* Signature Ed25519 du manifest (octets exacts du fichier publié). */
    let signed = null;

    if (args.sign) {
        const keys = require("./keys");
        signed = keys.signFile(path.join(outDir, pagesRel), path.resolve(String(args.sign)), await keys.getPassphrase("la clé de signature"));
        console.log(`Manifest signé avec la clé ${signed.keyId} (${signed.role}).`);
    } else {
        console.warn("ATTENTION : manifest NON signé (--sign <clé>). Les launchers refuseront de l'utiliser.");
    }

    for (const asset of newAssets) {
        const target = path.join(outDir, `release-${asset.tag}`, asset.assetName);
        if (asset.data) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, asset.data); }
        else linkOrCopy(asset.abs, target);
    }

    writeUploadGuide(outDir, manifest, newAssets, policy, channel, result.existingTags);

    fs.mkdirSync(manifestsDir, { recursive: true });
    fs.writeFileSync(path.join(manifestsDir, `manifest-${manifest.version}.json`), manifestText, "utf8");
    if (signed) fs.copyFileSync(path.join(outDir, pagesRel + ".sig"), path.join(manifestsDir, `manifest-${manifest.version}.json.sig`));

    if (args["write-docs"]) {
        const target = path.join(REPO_ROOT, pagesRel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, manifestText, "utf8");
        if (signed) fs.copyFileSync(path.join(outDir, pagesRel + ".sig"), target + ".sig");
        console.log(`Manifest${signed ? " et signature" : ""} copié${signed ? "s" : ""} dans ${pagesRel}`);
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
