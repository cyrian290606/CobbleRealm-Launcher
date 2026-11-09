#!/usr/bin/env node
"use strict";

/*
 * Gestion des clés de signature du manifest (outil administrateur). Aucune dépendance externe.
 *
 *   node tools/keys.js init --dir <dossierHorsDepot>            génère la clé principale + la clé de secours
 *   node tools/keys.js new-key --role primary|backup --dir <d>  génère une nouvelle clé (rotation), l'ajoute à la liste de confiance
 *   node tools/keys.js sign <manifest.json> --key <fichier.key.json>
 *   node tools/keys.js verify <manifest.json> [--sig <fichier.sig>] [--trust <trusted-keys.json>]
 *   node tools/keys.js revoke <keyId>                           interdit une clé (à livrer dans une mise à jour du launcher)
 *   node tools/keys.js status                                   état de la liste de confiance
 *   node tools/keys.js check-repo                               vérifie qu'aucune clé privée n'est dans le dépôt
 *   node tools/keys.js restore-test [--dir <originaux>]         retrouve les COPIES des clés sur tous les lecteurs et teste chacune (mot de passe demandé)
 *
 * Mot de passe : demandé au clavier (invisible), ou variable COBBLEREALM_KEY_PASSPHRASE (automatisation).
 * Les clés PRIVÉES (chiffrées) sont écrites uniquement dans un dossier HORS du dépôt Git ; seule la clé PUBLIQUE
 * entre dans updater/trusted-keys.json. Procédure complète : tools/SIGNATURES.md.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const sig = require("../updater/signature");

const REPO_ROOT = path.resolve(__dirname, "..");
const TRUST_FILE = process.env.COBBLEREALM_TRUST_FILE ? path.resolve(process.env.COBBLEREALM_TRUST_FILE) : sig.TRUSTED_KEYS_FILE;

/* ---------------- sécurité des emplacements ---------------- */

function insideGitRepo(dir) {

    let current = path.resolve(dir);

    for (;;) {
        if (fs.existsSync(path.join(current, ".git"))) return current;
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
    }
}

/** Refuse un dossier de clés situé dans le dépôt du launcher (ou dans n'importe quel dépôt Git). */
function assertSafeKeyDir(dir) {

    const resolved = path.resolve(dir);
    const rel = path.relative(REPO_ROOT, resolved);

    if (!rel.startsWith("..") && !path.isAbsolute(rel)) throw new Error(`Dossier refusé : ${resolved} est dans le dépôt du launcher. Choisis un dossier hors du dépôt (clé USB, dossier privé).`);

    const repo = insideGitRepo(resolved);
    if (repo) throw new Error(`Dossier refusé : ${resolved} est dans un dépôt Git (${repo}). Les clés privées ne doivent jamais y figurer.`);

    return resolved;
}

/* ---------------- mot de passe ---------------- */

function askHidden(question) {

    return new Promise((resolve) => {

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        let muted = false;
        const write = rl._writeToOutput;

        rl._writeToOutput = (text) => { if (!muted) write.call(rl, text); };
        rl.question(question, (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer); });
        muted = true;
    });
}

async function getPassphrase(label, { confirm = false, env = "COBBLEREALM_KEY_PASSPHRASE" } = {}) {

    if (process.env[env]) return process.env[env];
    if (env !== "COBBLEREALM_KEY_PASSPHRASE" && process.env.COBBLEREALM_KEY_PASSPHRASE) return process.env.COBBLEREALM_KEY_PASSPHRASE;

    const first = await askHidden(`Mot de passe pour ${label} (12 caractères minimum) : `);

    if (confirm && first !== await askHidden("Confirme le mot de passe : ")) throw new Error("Les deux mots de passe sont différents.");

    return first;
}

/* ---------------- liste de confiance ---------------- */

function readTrust() {
    return JSON.parse(fs.readFileSync(TRUST_FILE, "utf8"));
}

function writeTrust(data) {
    fs.writeFileSync(TRUST_FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/* ---------------- génération ---------------- */

/** Génère une paire de clés. Retourne { file (clé privée chiffrée), entry (clé publique pour la liste de confiance) }. */
function generateKey(role, passphrase) {

    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const raw = sig.rawFromPublicKey(publicKey);

    return {
        file: sig.encryptPrivateKey(privateKey, passphrase),
        entry: { id: sig.keyId(raw), role, publicKey: raw.toString("base64") }
    };
}

function writeKeyFile(dir, name, file) {

    fs.mkdirSync(dir, { recursive: true });

    const target = path.join(dir, name);

    if (fs.existsSync(target)) throw new Error(`${target} existe déjà : je ne l'écrase jamais (une clé écrasée serait perdue).`);

    fs.writeFileSync(target, JSON.stringify(file, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });

    return target;
}

/* ---------------- signature ---------------- */

function signFile(manifestPath, keyFilePath, passphrase) {

    const bytes = fs.readFileSync(manifestPath);
    const privateKey = sig.decryptPrivateKey(JSON.parse(fs.readFileSync(keyFilePath, "utf8")), passphrase);
    const signature = sig.signBytes(bytes, privateKey);

    /* Contrôle immédiat : la clé qui signe doit être dans la liste de confiance, sinon les launchers refuseraient. */
    const trusted = sig.parseTrustedKeys(readTrust());
    const result = sig.verifyManifestSignature(bytes, signature, trusted);

    fs.writeFileSync(`${manifestPath}.sig`, JSON.stringify(signature, null, 2) + "\n", "utf8");

    return { signature, ...result };
}

function verifyFile(manifestPath, sigPath = `${manifestPath}.sig`, trustPath = TRUST_FILE) {

    const bytes = fs.readFileSync(manifestPath);
    let signature = null;

    try { signature = JSON.parse(fs.readFileSync(sigPath, "utf8")); } catch { /* absent */ }

    return sig.verifyManifestSignature(bytes, signature, sig.parseTrustedKeys(JSON.parse(fs.readFileSync(trustPath, "utf8"))));
}

/* ---------------- dépôt ---------------- */

/** Fichiers du dépôt (suivis ou non) qui ressemblent à une clé privée. */
function findPrivateKeysInRepo(root = REPO_ROOT) {

    const found = [];
    const skip = new Set([".git", "node_modules", "dist", "build-out", "publish-out"]);

    const walk = (dir) => {

        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {

            if (skip.has(entry.name)) continue;

            const full = path.join(dir, entry.name);

            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.isFile() || fs.statSync(full).size > 64 * 1024) continue;

            let text = "";
            try { text = fs.readFileSync(full, "utf8"); } catch { continue; }

            if (text.includes(sig.PRIVATE_KEY_MARKER) || /-----BEGIN (ENCRYPTED |OPENSSH |EC )?PRIVATE KEY-----/.test(text)) {
                /* le code qui définit le marqueur n'est pas une clé */
                if (/\.js$|\.md$/i.test(entry.name)) continue;
                found.push(path.relative(root, full));
            }
        }
    };

    walk(root);
    return found;
}

/* ---------------- test de restauration ---------------- */

const KEY_NAME = /^(primary|backup)-[0-9a-f]{16}\.key\.json$/;
const SKIP_DIRS = new Set(["Windows", "Program Files", "Program Files (x86)", "ProgramData", "node_modules", ".git", "AppData", "Recovery", "System Volume Information"]);

/** Fichiers de clés trouvés sur les lecteurs (profondeur limitée). Ne lit aucun contenu. */
function findKeyCopies(roots, depth = 5) {

    const found = [];

    const walk = (dir, left) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isFile() && KEY_NAME.test(e.name)) found.push(full);
            else if (e.isDirectory() && left > 0 && !SKIP_DIRS.has(e.name) && !e.name.startsWith("$")) walk(full, left - 1);
        }
    };

    for (const root of roots) walk(root, depth);

    return found;
}

const fileHash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16);

/**
 * Prouve qu'une copie de clé fonctionne : le mot de passe la déchiffre, elle signe un fichier de test, la signature
 * est reconnue par la liste de confiance du launcher, et une falsification est refusée. N'écrit rien dans le dépôt.
 */
function testKeyFile(keyPath, passphrase) {

    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "cr-restore-"));
    const target = path.join(dir, "test.json");

    try {
        fs.writeFileSync(target, JSON.stringify({ test: "restauration", at: Date.now() }));
        const result = signFile(target, keyPath, passphrase);
        verifyFile(target);
        fs.appendFileSync(target, " ");
        let refused = false;
        try { verifyFile(target); } catch (e) { refused = e.code === "MANIFEST_SIGNATURE"; }
        if (!refused) throw new Error("une falsification n'a pas été refusée : ne pas utiliser cette clé");
        return result;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/* ---------------- ligne de commande ---------------- */

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith("--")) { const next = argv[i + 1]; if (next !== undefined && !next.startsWith("--")) { args[argv[i].slice(2)] = next; i++; } else args[argv[i].slice(2)] = true; }
        else args._.push(argv[i]);
    }
    return args;
}

async function main(argv) {

    const args = parseArgs(argv);
    const command = args._[0];

    if (command === "init") {

        if (!args.dir) throw new Error("Usage : node tools/keys.js init --dir <dossier hors du dépôt>");

        const dir = assertSafeKeyDir(args.dir);
        const trust = readTrust();

        if (trust.keys && trust.keys.length && !args.force) throw new Error("updater/trusted-keys.json contient déjà des clés. Pour une rotation, utilise « new-key » (ou --force pour repartir de zéro : tous les launchers existants refuseraient alors les anciens manifests).");

        const primaryPass = await getPassphrase("la clé PRINCIPALE", { confirm: true, env: "COBBLEREALM_KEY_PASSPHRASE_PRIMARY" });
        const backupPass = await getPassphrase("la clé de SECOURS (différent du premier !)", { confirm: true, env: "COBBLEREALM_KEY_PASSPHRASE_BACKUP" });

        if (primaryPass === backupPass) throw new Error("Utilise deux mots de passe différents : si l'un est découvert, l'autre clé doit rester sûre.");

        const primary = generateKey("primary", primaryPass);
        const backup = generateKey("backup", backupPass);

        const primaryFile = writeKeyFile(dir, `primary-${primary.entry.id}.key.json`, primary.file);
        const backupFile = writeKeyFile(dir, `backup-${backup.entry.id}.key.json`, backup.file);

        writeTrust({ ...trust, keys: [primary.entry, backup.entry], revoked: trust.revoked || [] });

        console.log("Clés générées.\n");
        console.log(`  Clé principale : ${primary.entry.id}\n    ${primaryFile}`);
        console.log(`  Clé de secours : ${backup.entry.id}\n    ${backupFile}\n`);
        console.log("Les clés PUBLIQUES ont été ajoutées à updater/trusted-keys.json (à valider avec git).");
        console.log("\nÀ FAIRE MAINTENANT (voir tools/SIGNATURES.md) :");
        console.log("  1. Copier les 2 fichiers .key.json sur DEUX supports hors ligne différents (clé USB + coffre), pas sur le même disque que ce PC.");
        console.log("  2. Noter les 2 mots de passe dans un gestionnaire de mots de passe (jamais dans le même endroit que les fichiers).");
        console.log("  3. Garder la clé de SECOURS séparée de la clé principale : elle ne sert qu'en cas de perte ou de vol de la principale.");
        console.log("  4. Reconstruire le launcher (npm run build) : les clés publiques doivent y être intégrées avant toute publication signée.");
        return 0;
    }

    if (command === "new-key") {

        const role = args.role;
        if (!["primary", "backup"].includes(role) || !args.dir) throw new Error("Usage : node tools/keys.js new-key --role primary|backup --dir <dossier hors du dépôt>");

        const dir = assertSafeKeyDir(args.dir);
        const pass = await getPassphrase(`la nouvelle clé ${role === "primary" ? "PRINCIPALE" : "de SECOURS"}`, { confirm: true });
        const created = generateKey(role, pass);
        const file = writeKeyFile(dir, `${role}-${created.entry.id}.key.json`, created.file);
        const trust = readTrust();

        trust.keys = [...(trust.keys || []), created.entry];
        writeTrust(trust);

        console.log(`Nouvelle clé ${role} : ${created.entry.id}\n  ${file}`);
        console.log("Ajoutée à updater/trusted-keys.json. Elle ne sera acceptée par les joueurs qu'APRÈS la publication d'une version du launcher qui la contient (voir tools/SIGNATURES.md, « Rotation »).");
        return 0;
    }

    if (command === "sign") {

        const manifest = args._[1];
        if (!manifest || !args.key) throw new Error("Usage : node tools/keys.js sign <manifest.json> --key <fichier.key.json>");

        const result = signFile(path.resolve(manifest), path.resolve(args.key), await getPassphrase("la clé de signature"));
        console.log(`Signé avec la clé ${result.keyId} (${result.role}) : ${path.resolve(manifest)}.sig`);
        return 0;
    }

    if (command === "verify") {

        const manifest = args._[1];
        if (!manifest) throw new Error("Usage : node tools/keys.js verify <manifest.json> [--sig <fichier>] [--trust <trusted-keys.json>]");

        const result = verifyFile(path.resolve(manifest), args.sig && path.resolve(args.sig), args.trust && path.resolve(args.trust));
        console.log(`Signature valide (clé ${result.keyId}, ${result.role}).`);
        return 0;
    }

    if (command === "revoke") {

        const id = args._[1];
        if (!id) throw new Error("Usage : node tools/keys.js revoke <keyId>");

        const trust = readTrust();
        trust.revoked = [...new Set([...(trust.revoked || []), id])];
        writeTrust(trust);
        console.log(`Clé ${id} révoquée dans updater/trusted-keys.json. Les launchers l'ignoreront après la publication d'une version qui contient cette liste.`);
        return 0;
    }

    if (command === "status") {

        const trust = readTrust();
        const parsed = sig.parseTrustedKeys(trust);
        console.log(`Clés de confiance : ${parsed.keys.length}`);
        for (const k of parsed.keys) console.log(`  ${k.id}  ${k.role.padEnd(8)} ${parsed.revoked.has(k.id) ? "RÉVOQUÉE" : "active"}`);
        const active = parsed.keys.filter((k) => !parsed.revoked.has(k.id));
        if (!active.some((k) => k.role === "primary")) console.log("ATTENTION : aucune clé principale active.");
        if (!active.some((k) => k.role === "backup")) console.log("ATTENTION : aucune clé de secours active (une perte de la clé principale serait irrécupérable).");
        return 0;
    }

    if (command === "check-repo") {

        const found = findPrivateKeysInRepo();
        if (found.length) { console.error("CLÉ PRIVÉE TROUVÉE DANS LE DÉPÔT :\n - " + found.join("\n - ")); return 1; }
        console.log("Aucune clé privée dans le dépôt.");
        return 0;
    }

    if (command === "restore-test") {

        const originals = path.resolve(args.dir || "D:\\CobbleRealm-Cles");
        const drives = process.platform === "win32" ? "CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((l) => l + ":\\").filter((d) => fs.existsSync(d)) : ["/"];
        const parsed = sig.parseTrustedKeys(readTrust());

        console.log("Lecteurs détectés : " + drives.map((d) => d[0]).join(" "));

        const copies = findKeyCopies(drives).filter((f) => !path.resolve(f).toLowerCase().startsWith(REPO_ROOT.toLowerCase()));
        const originalFiles = copies.filter((f) => path.resolve(path.dirname(f)).toLowerCase() === originals.toLowerCase());
        const backups = copies.filter((f) => !originalFiles.includes(f));
        const roles = { primary: 0, backup: 0 };

        console.log("\nOriginaux (" + originals + ") :");
        for (const f of originalFiles) console.log("  " + path.basename(f));
        if (!originalFiles.length) console.log("  (aucun)");

        console.log("\nCopies trouvées ailleurs :");
        for (const f of backups) {
            const original = originalFiles.find((o) => path.basename(o) === path.basename(f));
            const state = original ? (fileHash(f) === fileHash(original) ? "identique à l'original" : "DIFFÉRENTE de l'original") : "(pas d'original à comparer)";
            console.log("  " + f + "  -> " + state);
        }
        if (!backups.length) console.log("  AUCUNE : branche tes clés USB / supports de sauvegarde puis relance la commande.");

        for (const f of backups) {

            const file = JSON.parse(fs.readFileSync(f, "utf8"));
            const known = parsed.keys.find((k) => k.id === file.keyId);
            console.log("\n=== " + f + "\n    clé " + file.keyId + (known ? " (" + known.role + ")" : " : INCONNUE de la liste de confiance du launcher"));

            if (!known) continue;

            try {
                const r = testKeyFile(f, await getPassphrase("la clé " + (known.role === "backup" ? "de SECOURS" : "PRINCIPALE") + " " + file.keyId));
                roles[known.role]++;
                console.log("    OK : mot de passe correct, signature reconnue (" + r.role + "), falsification refusée.");
            } catch (error) {
                console.log("    ECHEC : " + error.message);
            }
        }

        console.log("\nBilan : copie PRINCIPALE testée : " + (roles.primary ? "OUI" : "non") + " · copie de SECOURS testée : " + (roles.backup ? "OUI" : "non"));
        return roles.primary && roles.backup ? 0 : 1;
    }

    console.error("Commandes : init | new-key | restore-test | sign | verify | revoke | status | check-repo (voir l'en-tête de tools/keys.js)");
    return 2;
}

module.exports = { findKeyCopies, testKeyFile, getPassphrase, assertSafeKeyDir, generateKey, signFile, verifyFile, findPrivateKeysInRepo, readTrust, writeTrust, REPO_ROOT };

if (require.main === module) {
    main(process.argv.slice(2)).then(
        (code) => process.exit(code),
        (error) => { console.error("Erreur :", error.message); process.exit(1); }
    );
}
