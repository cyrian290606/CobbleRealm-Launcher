#!/usr/bin/env node
"use strict";

/*
 * Serveur de test local (environnement de répétition, aucune dépendance).
 *
 * Sert un manifest et ses fichiers avec support de Range, et peut simuler des pannes :
 *   - cutAfter  : coupe la connexion après N octets (une seule fois par fichier)
 *   - corrupt   : sert un fichier avec un octet modifié
 *   - fail      : répond HTTP 503 pendant N requêtes
 *   - ignoreRange : ignore l'en-tête Range
 *
 * En ligne de commande, il sert un dossier produit par tools/publish.js :
 *   node tools/test-server.js publish-out [--port 8787] [--cut-after 5000000]
 * puis lancer le launcher avec :
 *   COBBLEREALM_DEV=1 COBBLEREALM_ROOT=C:\temp\test-jeu COBBLEREALM_MANIFEST_URL=http://127.0.0.1:8787/manifest.json npm start
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

function createTestServer({ manifest = null, blobs = new Map(), faults = {}, signer = null } = {}) {

    const state = {
        manifest,                 // objet manifest servi sur /manifest.json
        blobs,                    // pathname -> Buffer
        faults: { cutAfter: {}, corrupt: new Set(), fail: {}, ignoreRange: false, redirect: {}, ...faults },
        signer,                   // fonction de signature du manifest (ou null : manifest non signé)
        requests: [],             // { path, range }
        stats: { requests: 0, files: 0, bytes: 0 },   // mesures : requêtes (hors manifest), requêtes de fichiers, octets envoyés
        cutDone: new Set()
    };

    const server = http.createServer((req, res) => {

        /* Latence simulée (ms) : reproduit le temps de réponse d'un serveur distant (GitHub ~ 65 ms) ; mesures de volume. */
        const send = () => handle(req, res);
        state.stats.requests++;
        if (new URL(req.url, "http://localhost").pathname.startsWith("/files/") || new URL(req.url, "http://localhost").pathname.startsWith("/f/")) state.stats.files++;
        const write = res.write.bind(res), end = res.end.bind(res);
        res.write = (chunk, ...rest) => { if (chunk) state.stats.bytes += Buffer.byteLength(chunk); return write(chunk, ...rest); };
        res.end = (chunk, ...rest) => { if (chunk && typeof chunk !== "function") state.stats.bytes += Buffer.byteLength(chunk); return end(chunk, ...rest); };

        if (state.faults.latencyMs) setTimeout(send, state.faults.latencyMs); else send();
    });

    function handle(req, res) {

        const url = new URL(req.url, "http://localhost");
        const pathname = url.pathname;
        const range = req.headers.range || null;

        state.requests.push({ path: pathname, range });

        if (state.faults.fail[pathname] > 0) {
            state.faults.fail[pathname]--;
            res.writeHead(503); return res.end("indisponible");
        }
        if (state.faults.fail[pathname] === Infinity) { res.writeHead(503); return res.end(); }

        if (state.faults.redirect[pathname]) {
            res.writeHead(302, { Location: state.faults.redirect[pathname] }); return res.end();
        }

        /* Signature du manifest (signer : octets -> { alg, keyId, signature }). Absente si aucun signataire n'est configuré. */
        if (pathname === "/manifest.json.sig") {
            if (!state.signer) { res.writeHead(404); return res.end("non signé"); }
            const body = Buffer.from(JSON.stringify(state.signer(Buffer.from(JSON.stringify(state.manifest)))));
            res.writeHead(200, { "Content-Type": "application/json", "Content-Length": body.length });
            return res.end(body);
        }

        if (pathname === "/manifest.json") {
            const body = Buffer.from(JSON.stringify(state.manifest));
            res.writeHead(200, { "Content-Type": "application/json", "Content-Length": body.length });
            return res.end(body);
        }

        let blob = state.blobs.get(pathname);
        if (!blob) { res.writeHead(404); return res.end("introuvable"); }

        if (state.faults.corrupt.has(pathname)) {
            blob = Buffer.from(blob);
            blob[Math.floor(blob.length / 2)] ^= 0xff;
        }

        let start = 0;
        const match = !state.faults.ignoreRange && range && /^bytes=(\d+)-$/.exec(range);

        if (match) {
            start = Number(match[1]);
            if (start >= blob.length) { res.writeHead(416, { "Content-Range": `bytes */${blob.length}` }); return res.end(); }
            res.writeHead(206, {
                "Content-Range": `bytes ${start}-${blob.length - 1}/${blob.length}`,
                "Content-Length": blob.length - start, "Accept-Ranges": "bytes"
            });
        } else {
            res.writeHead(200, { "Content-Length": blob.length, "Accept-Ranges": "bytes" });
        }

        const cut = state.faults.cutAfter[pathname];

        if (cut !== undefined && !state.cutDone.has(pathname) && start + cut < blob.length) {
            state.cutDone.add(pathname);
            res.write(blob.subarray(start, start + cut));
            setTimeout(() => res.destroy(), 20);        // coupure brutale
            return;
        }

        const body = blob.subarray(start);
        const bytesPerSecond = state.faults.throttleBytesPerSec;

        if (!bytesPerSecond) return res.end(body);

        /* Débit limité (pour voir la barre de progression) */
        let position = 0;
        const step = Math.max(1, Math.floor(bytesPerSecond / 10));
        const tick = () => {
            if (res.destroyed) return;
            if (position >= body.length) return res.end();
            res.write(body.subarray(position, position + step));
            position += step;
            setTimeout(tick, 100);
        };
        tick();
    }

    return {
        state,
        listen: (port = 0) => new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`))),
        close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })
    };
}

/* Mode ligne de commande : sert un dossier produit par publish.js. */
async function serveFolder(dir, { port = 8787, cutAfter = 0, speedKb = 0, signKey = null, latencyMs = 0 } = {}) {

    const manifestFile = fs.existsSync(path.join(dir, "docs", "manifest.json"))
        ? path.join(dir, "docs", "manifest.json")
        : path.join(dir, "manifest.json");

    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    const blobs = new Map();
    const assets = new Map();

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith("release-")) {
            for (const f of fs.readdirSync(path.join(dir, entry.name))) assets.set(f, path.join(dir, entry.name, f));
        }
    }

    const base = `http://127.0.0.1:${port}`;
    let missing = 0;

    for (const f of manifest.files) {
        if (!f.url) continue;          // fichier d'un bundle : pas d'URL propre
        const assetName = decodeURIComponent(f.url.split("/").pop());
        const source = assets.get(assetName);
        f.url = `${base}/files/${encodeURIComponent(assetName)}`;
        if (source) blobs.set(`/files/${encodeURIComponent(assetName)}`, fs.readFileSync(source));
        else missing++;
    }

    /* Les URL du manifest sont réécrites vers ce serveur : la signature d'origine ne vaut plus, on re-signe avec une clé de TEST (--sign-key). */
    let signer = null;

    if (signKey) {
        const sig = require("../updater/signature");
        const privateKey = sig.decryptPrivateKey(JSON.parse(fs.readFileSync(signKey, "utf8")), process.env.COBBLEREALM_KEY_PASSPHRASE || "");
        signer = (bytes) => sig.signBytes(bytes, privateKey);
    }

    /* Bundles : même réécriture d'URL que pour les fichiers */
    for (const b of manifest.bundles || []) {
        const assetName = decodeURIComponent(b.url.split("/").pop());
        const source = assets.get(assetName);
        b.url = `${base}/files/${encodeURIComponent(assetName)}`;
        if (source) blobs.set(`/files/${encodeURIComponent(assetName)}`, fs.readFileSync(source));
        else missing++;
    }

    const server = createTestServer({ manifest, blobs, signer });
    if (latencyMs > 0) server.state.faults.latencyMs = latencyMs;

    if (cutAfter > 0) for (const key of blobs.keys()) server.state.faults.cutAfter[key] = cutAfter;
    if (speedKb > 0) server.state.faults.throttleBytesPerSec = speedKb * 1024;

    return { server, base, missing };
}

if (require.main === module) {

    const args = process.argv.slice(2);
    const dir = args.find((a) => !a.startsWith("--"));
    const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

    if (!dir) {
        console.error("Usage : node tools/test-server.js <dossier publish-out> [--port 8787] [--cut-after octets] [--speed Ko/s] [--latency ms] [--sign-key clé-de-TEST.key.json (mot de passe : COBBLEREALM_KEY_PASSPHRASE)]");
        process.exit(2);
    }

    const port = Number(opt("port") || 8787);

    serveFolder(path.resolve(dir), { port, cutAfter: Number(opt("cut-after") || 0), speedKb: Number(opt("speed") || 0), signKey: opt("sign-key"), latencyMs: Number(opt("latency") || 0) }).then(async ({ server, base, missing }) => {
        await server.listen(port);
        console.log(`Serveur de test : ${base}/manifest.json`);
        if (missing) console.warn(`Attention : ${missing} fichier(s) du manifest absents des dossiers release-*`);
        console.log("Ctrl+C pour arrêter.");
    });
}

module.exports = { createTestServer, serveFolder };
