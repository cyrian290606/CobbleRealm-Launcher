"use strict";

/*
 * Signature Ed25519 du manifest.
 *
 * Pourquoi : si le compte GitHub ou GitHub Pages était piraté, un manifest modifié pourrait faire installer
 * n'importe quel fichier (donc du code) chez tous les joueurs. Le manifest est donc signé par l'administrateur,
 * hors ligne, et le launcher refuse tout manifest dont la signature n'est pas valide.
 *
 * - La signature porte sur les OCTETS EXACTS de manifest.json (vérifiée avant toute lecture du contenu).
 * - manifest.json.sig = { "alg": "ed25519", "keyId": "...", "signature": "<base64>" }
 * - Le launcher embarque des clés PUBLIQUES (updater/trusted-keys.json) : une clé « primary » et une clé « backup ».
 *   Les clés privées n'existent jamais ici : seulement chez l'administrateur (voir tools/keys.js).
 * - Une clé listée dans « revoked » est refusée, même si elle figure encore dans « keys ».
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { UpdateError } = require("./errors");

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");     // en-tête DER d'une clé publique Ed25519
const TRUSTED_KEYS_FILE = path.join(__dirname, "trusted-keys.json");

const sigError = (message, details = null) => new UpdateError("MANIFEST_SIGNATURE", message, { details });

const MESSAGES = {
    MISSING: "La liste de mise à jour n'est pas signée : par sécurité, rien n'a été installé. Préviens l'équipe CobbleRealm.",
    INVALID: "La signature de la liste de mise à jour est invalide : par sécurité, rien n'a été installé. Préviens l'équipe CobbleRealm.",
    UNKNOWN_KEY: "La liste de mise à jour est signée avec une clé inconnue de ce launcher : par sécurité, rien n'a été installé. Mets à jour le launcher ou préviens l'équipe CobbleRealm.",
    REVOKED: "La clé de signature de la liste de mise à jour a été révoquée : par sécurité, rien n'a été installé. Mets à jour le launcher ou préviens l'équipe CobbleRealm.",
    NOT_CONFIGURED: "La vérification de sécurité des mises à jour n'est pas configurée dans ce launcher. Préviens l'équipe CobbleRealm."
};

/** Identifiant court d'une clé publique : 16 premiers caractères hexadécimaux du SHA-256 de la clé brute. */
function keyId(rawPublicKey) {
    return crypto.createHash("sha256").update(rawPublicKey).digest("hex").slice(0, 16);
}

function publicKeyObject(rawPublicKey) {
    return crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, rawPublicKey]), format: "der", type: "spki" });
}

function rawFromPublicKey(publicKey) {
    const pub = publicKey.type === "public" ? publicKey : crypto.createPublicKey(publicKey);

    return pub.export({ format: "der", type: "spki" }).subarray(SPKI_ED25519_PREFIX.length);
}

/** Valide le contenu d'un trusted-keys.json (jamais de confiance aveugle, même dans un fichier embarqué). */
function parseTrustedKeys(data) {

    const keys = [];
    const revoked = new Set();

    if (!data || typeof data !== "object" || !Array.isArray(data.keys)) throw new Error("trusted-keys : format invalide");

    for (const entry of data.keys) {

        if (!entry || typeof entry.publicKey !== "string") throw new Error("trusted-keys : clé invalide");

        const raw = Buffer.from(entry.publicKey, "base64");
        if (raw.length !== 32) throw new Error("trusted-keys : une clé publique Ed25519 fait 32 octets");

        const id = keyId(raw);
        if (entry.id && entry.id !== id) throw new Error(`trusted-keys : l'identifiant ${entry.id} ne correspond pas à la clé (${id})`);

        keys.push({ id, role: entry.role === "backup" ? "backup" : "primary", raw });
    }

    for (const id of Array.isArray(data.revoked) ? data.revoked : []) revoked.add(String(id));

    return { keys, revoked };
}

function loadTrustedKeys(file = TRUSTED_KEYS_FILE) {
    return parseTrustedKeys(JSON.parse(fs.readFileSync(file, "utf8")));
}

/**
 * Signe des octets (outil administrateur).
 * @param {Buffer} bytes
 * @param {crypto.KeyObject} privateKey
 */
function signBytes(bytes, privateKey) {

    const raw = rawFromPublicKey(crypto.createPublicKey(privateKey));

    return {
        alg: "ed25519",
        keyId: keyId(raw),
        signature: crypto.sign(null, bytes, privateKey).toString("base64")
    };
}

/**
 * Vérifie la signature d'un manifest. Lève MANIFEST_SIGNATURE (message lisible) en cas de refus.
 * @param {Buffer} bytes     octets exacts reçus pour manifest.json
 * @param {object|null} sig  contenu de manifest.json.sig
 * @param {{keys:Array, revoked:Set}} trusted
 * @returns {{keyId:string, role:string}}
 */
function verifyManifestSignature(bytes, sig, trusted) {

    if (!trusted || !trusted.keys.length) throw sigError(MESSAGES.NOT_CONFIGURED, "aucune clé de confiance");
    if (!sig || typeof sig !== "object") throw sigError(MESSAGES.MISSING, "signature absente");
    if (sig.alg !== "ed25519" || typeof sig.keyId !== "string" || typeof sig.signature !== "string") throw sigError(MESSAGES.INVALID, "format de signature invalide");
    if (trusted.revoked.has(sig.keyId)) throw sigError(MESSAGES.REVOKED, `clé ${sig.keyId} révoquée`);

    const key = trusted.keys.find((k) => k.id === sig.keyId);
    if (!key) throw sigError(MESSAGES.UNKNOWN_KEY, `clé ${sig.keyId} inconnue`);

    const signature = Buffer.from(sig.signature, "base64");
    let ok = false;

    try {
        ok = signature.length === 64 && crypto.verify(null, bytes, publicKeyObject(key.raw), signature);
    } catch { ok = false; }

    if (!ok) throw sigError(MESSAGES.INVALID, `signature invalide (clé ${key.id})`);

    return { keyId: key.id, role: key.role };
}

/* ---------------- fichiers de clés privées chiffrés (outil administrateur) ---------------- */

const PRIVATE_KEY_MARKER = "COBBLEREALM-PRIVATE-KEY";
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

/** Chiffre une clé privée avec un mot de passe (scrypt + AES-256-GCM). Le fichier ne contient jamais la clé en clair. */
function encryptPrivateKey(privateKey, passphrase) {

    if (typeof passphrase !== "string" || passphrase.length < 12) throw new Error("mot de passe trop court (12 caractères minimum)");

    const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const derived = crypto.scryptSync(passphrase, salt, 32, SCRYPT);
    const cipher = crypto.createCipheriv("aes-256-gcm", derived, iv);
    const ciphertext = Buffer.concat([cipher.update(pkcs8), cipher.final()]);

    return {
        kind: PRIVATE_KEY_MARKER, version: 1, alg: "ed25519",
        keyId: keyId(rawFromPublicKey(crypto.createPublicKey(privateKey))),
        kdf: { name: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("base64") },
        cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") },
        data: ciphertext.toString("base64")
    };
}

function decryptPrivateKey(file, passphrase) {

    if (!file || file.kind !== PRIVATE_KEY_MARKER) throw new Error("ce fichier n'est pas une clé privée CobbleRealm");

    try {
        const derived = crypto.scryptSync(passphrase, Buffer.from(file.kdf.salt, "base64"), 32,
            { N: file.kdf.N, r: file.kdf.r, p: file.kdf.p, maxmem: SCRYPT.maxmem });
        const decipher = crypto.createDecipheriv("aes-256-gcm", derived, Buffer.from(file.cipher.iv, "base64"));
        decipher.setAuthTag(Buffer.from(file.cipher.tag, "base64"));
        const pkcs8 = Buffer.concat([decipher.update(Buffer.from(file.data, "base64")), decipher.final()]);

        return crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });

    } catch {
        throw new Error("mot de passe incorrect ou fichier de clé abîmé");
    }
}

module.exports = {
    keyId, publicKeyObject, rawFromPublicKey, parseTrustedKeys, loadTrustedKeys, signBytes, verifyManifestSignature,
    encryptPrivateKey, decryptPrivateKey, PRIVATE_KEY_MARKER, TRUSTED_KEYS_FILE, MESSAGES
};
