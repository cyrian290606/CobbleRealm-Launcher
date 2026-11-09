"use strict";

/*
 * Java pour Minecraft : on cherche d'abord un Java >= version demandée (64 bits),
 * sinon on télécharge un JRE Temurin (Eclipse Adoptium) dans .cobblerealm/runtime/.
 *
 * Intégrité : le lien de téléchargement, la taille et le SHA-256 viennent de l'API officielle
 * Adoptium (api.adoptium.net) ; le binaire vient de github.com (releases adoptium/temurin*).
 * Le SHA-256 est vérifié avant toute extraction.
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const extract = require("extract-zip");
const { getJson } = require("./updater/http");
const { downloadAll } = require("./updater/download");
const { renameRetrySync } = require("./updater/util");

const API_HOST = "api.adoptium.net";

/** "openjdk version \"21.0.4\" ..." ou "java version \"1.8.0_301\"" -> { major, is64 } */
function parseJavaVersion(text) {

    const match = /version "(\d+)(?:\.(\d+))?/.exec(text || "");
    if (!match) return null;

    const major = match[1] === "1" ? Number(match[2]) : Number(match[1]);

    return { major, is64: /64-Bit/i.test(text) };
}

function probeJava(javaPath, exec = execFile) {

    return new Promise((resolve) => {
        exec(javaPath, ["-version"], { timeout: 15000, windowsHide: true }, (error, stdout, stderr) => {
            const info = parseJavaVersion(`${stderr || ""}\n${stdout || ""}`);
            resolve(error && !info ? null : info);
        });
    });
}

function managedJavaPath(runtimeRoot, required) {
    return path.join(runtimeRoot, `java${required}`, "bin", process.platform === "win32" ? "java.exe" : "java");
}

/** Cherche un Java utilisable. Retourne son chemin, ou null. */
async function findJava({ runtimeRoot, required, exec = execFile, env = process.env }) {

    const candidates = [];
    const managed = managedJavaPath(runtimeRoot, required);

    if (fs.existsSync(managed)) candidates.push(managed);

    if (env.JAVA_HOME) {
        candidates.push(path.join(env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java"));
    }

    candidates.push("java");

    for (const candidate of candidates) {

        if (candidate !== "java" && !fs.existsSync(candidate)) continue;

        const info = await probeJava(candidate, exec);

        if (info && info.major >= required && info.is64) return candidate;
    }

    return null;
}

async function downloadRuntime({ runtimeRoot, required, onStatus, apiBase, allowLocal, exec }) {

    const api = `${apiBase}/v3/assets/latest/${required}/hotspot?architecture=x64&image_type=jre&os=windows`;

    let assets;

    try {
        assets = await getJson(api, { allowedHosts: [API_HOST], allowLocal, timeoutMs: 20000 });
    } catch {
        throw new Error(`Impossible de télécharger Java ${required}. Vérifie ta connexion Internet puis réessaie.`);
    }

    const pkg = (Array.isArray(assets) ? assets : [])
        .map((a) => a && a.binary && a.binary.package)
        .find((p) => p && typeof p.link === "string" && /\.zip$/i.test(p.name || "") &&
            /^[0-9a-f]{64}$/.test(p.checksum || "") && Number.isSafeInteger(p.size) && p.size > 0);

    if (!pkg) throw new Error(`Aucun Java ${required} compatible n'a été trouvé. Préviens l'équipe CobbleRealm.`);

    const downloadDir = path.join(runtimeRoot, ".download");
    const tempDir = path.join(runtimeRoot, `java${required}-temp`);
    const finalDir = path.join(runtimeRoot, `java${required}`);

    fs.rmSync(tempDir, { recursive: true, force: true });

    onStatus(`Téléchargement de Java ${required}... 0%`);

    await downloadAll(
        [{ sha256: pkg.checksum, size: pkg.size, url: pkg.link, label: pkg.name }],
        {
            stagingDir: downloadDir, allowLocal,
            onProgress: (p) => onStatus(`Téléchargement de Java ${required}... ${p.percent}%`)
        }
    );

    onStatus(`Installation de Java ${required}...`);

    fs.mkdirSync(tempDir, { recursive: true });
    await extract(path.join(downloadDir, `${pkg.checksum}.dl`), { dir: tempDir });

    const folder = fs.readdirSync(tempDir, { withFileTypes: true }).find((e) => e.isDirectory());
    if (!folder) throw new Error("L'archive Java téléchargée est vide.");

    const extracted = path.join(tempDir, folder.name);
    const exe = path.join(extracted, "bin", process.platform === "win32" ? "java.exe" : "java");

    if (!fs.existsSync(exe)) throw new Error("Java a été téléchargé mais java.exe est introuvable.");

    const info = await probeJava(exe, exec);
    if (!info || info.major < required) throw new Error(`Le Java téléchargé ne fonctionne pas (version ${required} attendue).`);

    fs.rmSync(finalDir, { recursive: true, force: true });
    renameRetrySync(extracted, finalDir);
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(downloadDir, { recursive: true, force: true });
}

/**
 * Retourne le chemin d'un Java >= required, en le téléchargeant si nécessaire.
 * @param {object} p { runtimeRoot, required, onStatus, apiBase, allowLocal, exec, env }
 */
async function ensureJava({
    runtimeRoot, required = 21, onStatus = () => {},
    apiBase = `https://${API_HOST}`, allowLocal = false, exec = execFile, env = process.env
}) {

    fs.mkdirSync(runtimeRoot, { recursive: true });

    const found = await findJava({ runtimeRoot, required, exec, env });
    if (found) return found;

    onStatus(`Installation de Java ${required}...`);
    await downloadRuntime({ runtimeRoot, required, onStatus, apiBase, allowLocal, exec });

    const installed = managedJavaPath(runtimeRoot, required);

    if (!fs.existsSync(installed)) throw new Error(`Java ${required} n'a pas pu être installé.`);

    return installed;
}

module.exports = { ensureJava, findJava, parseJavaVersion, managedJavaPath };
