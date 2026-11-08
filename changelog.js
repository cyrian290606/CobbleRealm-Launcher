"use strict";

/*
 * Changelog public du launcher (CHANGELOG.md), affiché dans la page « Changelog ».
 *
 * Sources, dans l'ordre : en ligne (mise à jour sans republier le launcher) ->
 * dernière version connue (cache) -> version intégrée au launcher.
 * Les actualités du modpack (news.json) restent séparées.
 */

const fs = require("fs");
const path = require("path");
const { request } = require("./updater/http");
const { MANIFEST_HOSTS } = require("./updater/manifest");

const MAX_BYTES = 200 * 1024;
const MAX_VERSIONS = 30;
const MAX_ITEMS_PER_SECTION = 60;
const MAX_TEXT = 300;

const SECTIONS = ["Nouveautés", "Améliorations", "Corrections"];

/* Texte brut : retire la mise en forme Markdown et tout HTML. */
function plain(text) {

    return String(text)
        .replace(/<[^>]*>/g, "")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_`~]+/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_TEXT);
}

/**
 * Lit un CHANGELOG.md.
 * Format : « ## Version 2.0.0 », puis « ### Nouveautés | Améliorations | Corrections », puis « - élément ».
 * @returns {Array<{version: string, date: string|null, sections: Array<{title: string, items: string[]}>}>}
 */
function parseChangelog(markdown) {

    const versions = [];
    let current = null;
    let section = null;

    for (const rawLine of String(markdown).replace(/\r/g, "").split("\n")) {

        const line = rawLine.trim();

        const versionMatch = /^##\s+Version\s+(\d+(?:\.\d+){1,3})\s*(?:[—–-]\s*(.+?)|\((.+?)\))?\s*$/i.exec(line);

        if (versionMatch) {

            if (versions.length >= MAX_VERSIONS) break;

            current = {
                version: versionMatch[1],
                date: plain(versionMatch[2] || versionMatch[3] || "") || null,
                sections: []
            };

            versions.push(current);
            section = null;

            continue;
        }

        if (!current) continue;

        const sectionMatch = /^###\s+(.+)$/.exec(line);

        if (sectionMatch) {

            const title = plain(sectionMatch[1]);

            section = SECTIONS.find((name) => name.toLowerCase() === title.toLowerCase()) ? { title: SECTIONS.find((name) => name.toLowerCase() === title.toLowerCase()), items: [] } : null;

            if (section) current.sections.push(section);

            continue;
        }

        const itemMatch = /^[-*]\s+(.+)$/.exec(line);

        if (itemMatch && section && section.items.length < MAX_ITEMS_PER_SECTION) {

            const text = plain(itemMatch[1]);

            if (text) section.items.push(text);
        }
    }

    /* Une version sans aucun élément n'apporte rien au joueur. */
    return versions
        .map((v) => ({ ...v, sections: v.sections.filter((s) => s.items.length > 0) }))
        .filter((v) => v.sections.length > 0);
}

async function fetchText(url, { allowLocal = false, timeoutMs = 8000, requestFn = request } = {}) {

    const response = await requestFn(url, { allowedHosts: MANIFEST_HOSTS, allowLocal, timeoutMs });

    const chunks = [];
    let total = 0;

    for await (const chunk of response) {

        total += chunk.length;

        if (total > MAX_BYTES) {
            response.destroy();
            throw new Error("changelog trop volumineux");
        }

        chunks.push(chunk);
    }

    return Buffer.concat(chunks).toString("utf8");
}

function readFileSafe(file) {
    try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

function writeCache(cachePath, markdown) {

    try {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(`${cachePath}.tmp`, JSON.stringify({ fetchedAt: new Date().toISOString(), markdown }), "utf8");
        fs.renameSync(`${cachePath}.tmp`, cachePath);
    } catch { /* le cache est facultatif */ }
}

function readCache(cachePath) {

    try {
        const data = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        return typeof data.markdown === "string" ? data.markdown : null;
    } catch {
        return null;
    }
}

/** Version disponible tout de suite, sans réseau : cache sinon intégrée. */
function loadLocal({ embeddedPath, cachePath }) {

    const cached = readCache(cachePath);

    if (cached) {
        const versions = parseChangelog(cached);
        if (versions.length) return { versions, source: "cache" };
    }

    const embedded = readFileSafe(embeddedPath);
    const versions = embedded ? parseChangelog(embedded) : [];

    return { versions, source: versions.length ? "embedded" : "none" };
}

/**
 * Tente la source en ligne. Réussite : { versions, source: "online" } et mise en cache.
 * Échec (hors-ligne, fichier invalide, trop gros) : retourne null (le joueur garde la version locale).
 */
async function loadOnline({ url, cachePath, allowLocal = false, requestFn }) {

    try {

        const markdown = await fetchText(url, { allowLocal, requestFn });
        const versions = parseChangelog(markdown);

        if (versions.length === 0) return null;

        writeCache(cachePath, markdown);

        return { versions, source: "online" };

    } catch {
        return null;
    }
}

module.exports = { parseChangelog, loadLocal, loadOnline, plain };
