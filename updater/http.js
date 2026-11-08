"use strict";

/*
 * Requêtes HTTP(S) sécurisées pour le launcher :
 *  - liste blanche de domaines, vérifiée à CHAQUE redirection ;
 *  - timeout d'inactivité ;
 *  - flux (jamais de fichier entier en mémoire) ;
 *  - support de l'en-tête Range pour reprendre un téléchargement.
 */

const https = require("https");
const http = require("http");
const { forbiddenHostError } = require("./errors");

const LOCAL_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];

function isHostAllowed(hostname, allowedHosts) {

    const host = String(hostname).toLowerCase();

    return allowedHosts.some((pattern) => {
        const p = pattern.toLowerCase();
        return p.startsWith("*.") ? host.endsWith(p.slice(1)) && host.length > p.length - 1 : host === p;
    });
}

/* Lève FORBIDDEN_HOST si l'URL n'est pas autorisée. Retourne l'objet URL. */
function checkUrl(urlString, { allowedHosts, allowLocal = false }) {

    let url;

    try { url = new URL(urlString); }
    catch { throw forbiddenHostError(String(urlString).slice(0, 80)); }

    const local = LOCAL_HOSTS.includes(url.hostname);

    if (local && allowLocal && (url.protocol === "http:" || url.protocol === "https:")) return url;
    if (url.protocol !== "https:") throw forbiddenHostError(`${url.protocol}//${url.hostname}`);
    if (url.username || url.password) throw forbiddenHostError(url.hostname);
    if (!isHostAllowed(url.hostname, allowedHosts)) throw forbiddenHostError(url.hostname);

    return url;
}

/**
 * Retourne la réponse (200 ou 206) sous forme de flux lisible.
 * Les statuts d'erreur lèvent une erreur avec .httpStatus.
 */
function request(urlString, {
    headers = {}, timeoutMs = 30000, allowedHosts, allowLocal = false,
    maxRedirects = 5, signal = null
} = {}) {

    return new Promise((resolve, reject) => {

        let redirects = 0;
        let currentRequest = null;

        const abort = () => {
            if (currentRequest) currentRequest.destroy(Object.assign(new Error("aborted"), { name: "AbortError" }));
        };

        if (signal) {
            if (signal.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            signal.addEventListener("abort", abort, { once: true });
        }

        const go = (target) => {

            let url;

            try { url = checkUrl(target, { allowedHosts, allowLocal }); }
            catch (error) { return reject(error); }

            const client = url.protocol === "http:" ? http : https;

            currentRequest = client.get(url, {
                headers: { "User-Agent": "CobbleRealm-Launcher", Accept: "*/*", ...headers }
            }, (response) => {

                const status = response.statusCode;

                if (status >= 300 && status < 400 && response.headers.location) {

                    response.resume();

                    if (++redirects > maxRedirects) {
                        return reject(Object.assign(new Error("trop de redirections"), { httpStatus: 310 }));
                    }

                    return go(new URL(response.headers.location, url).href);
                }

                if (status !== 200 && status !== 206) {
                    response.resume();
                    return reject(Object.assign(new Error(`HTTP ${status}`), { httpStatus: status }));
                }

                resolve(response);
            });

            currentRequest.setTimeout(timeoutMs, () => {
                currentRequest.destroy(Object.assign(new Error("délai dépassé"), { code: "ETIMEDOUT" }));
            });

            currentRequest.on("error", reject);
        };

        go(urlString);
    });
}

/* Lit une réponse JSON de taille limitée. */
async function getJson(urlString, options = {}) {

    const maxBytes = options.maxBytes || 10 * 1024 * 1024;
    const response = await request(urlString, options);
    const chunks = [];
    let total = 0;

    for await (const chunk of response) {
        total += chunk.length;
        if (total > maxBytes) {
            response.destroy();
            throw Object.assign(new Error("réponse trop volumineuse"), { httpStatus: 413 });
        }
        chunks.push(chunk);
    }

    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/* Lit une réponse (octets bruts) de taille limitée. */
async function getBuffer(urlString, options = {}) {

    const maxBytes = options.maxBytes || 10 * 1024 * 1024;
    const response = await request(urlString, options);
    const chunks = [];
    let total = 0;

    for await (const chunk of response) {
        total += chunk.length;
        if (total > maxBytes) {
            response.destroy();
            throw Object.assign(new Error("réponse trop volumineuse"), { httpStatus: 413 });
        }
        chunks.push(chunk);
    }

    return Buffer.concat(chunks);
}

module.exports = { request, getJson, getBuffer, checkUrl, isHostAllowed };
