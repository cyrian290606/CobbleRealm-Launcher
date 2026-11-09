/*
 * Tests du kit de transition 1.0.x -> 2.0 (tools/transition/) : l'annonce doit être comprise par l'ANCIEN launcher
 * (même fonction de lecture que la 1.0.x) et le launcher 2.0 doit lire un fichier d'annonces distinct.
 * Lancer avec : node test/transition.test.js
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* Copie fidèle de normalizeLauncherNews() du launcher 1.0.x (branche main du dépôt Launcher) : c'est CE code qui lira l'annonce. */
function normalizeLegacyNews(data, fallback) {
    if (!data || typeof data !== "object") return null;
    const text = (v, f) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : f);
    const badge = text(data.badge, fallback.badge);
    const title = text(data.title, fallback.title);
    const titleHighlight = text(data.titleHighlight, text(data.highlight, fallback.titleHighlight));
    const version = text(data.version, fallback.version);
    const source = Array.isArray(data.paragraphs) ? data.paragraphs : (Array.isArray(data.content) ? data.content : []);
    const paragraphs = source.map((paragraph) => {
        if (Array.isArray(paragraph)) {
            return paragraph.map((part) => {
                if (typeof part === "string") return { text: part, className: "" };
                if (part && typeof part === "object" && typeof part.text === "string") return { text: part.text, className: typeof part.className === "string" ? part.className : "" };
                return null;
            }).filter(Boolean);
        }
        if (typeof paragraph === "string") return [{ text: paragraph, className: "" }];
        return null;
    }).filter((p) => Array.isArray(p) && p.length > 0);
    return { badge, title, titleHighlight, version, paragraphs: paragraphs.length ? paragraphs : fallback.paragraphs, usedFallbackParagraphs: paragraphs.length === 0 };
}

const FALLBACK = { badge: "FALLBACK", title: "FALLBACK", titleHighlight: "FALLBACK", version: "FALLBACK", paragraphs: [[{ text: "FALLBACK", className: "" }]] };
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

test("L'annonce de transition est lue telle quelle par l'ancien launcher (aucun repli sur le texte par défaut)", () => {
    const news = normalizeLegacyNews(readJson("tools/transition/news.json"), FALLBACK);
    assert.strictEqual(news.usedFallbackParagraphs, false);
    for (const field of ["badge", "title", "titleHighlight", "version"]) assert.notStrictEqual(news[field], "FALLBACK", field);
    assert.ok(news.paragraphs.length >= 2 && news.paragraphs.length <= 4, "assez courte pour la carte de l'ancien launcher");
    const classes = new Set(news.paragraphs.flat().map((p) => p.className));
    for (const c of classes) assert.ok(["", "cyan", "green", "orange", "purple"].includes(c), `couleur inconnue : ${c}`);
});

test("L'annonce dit quoi faire, où, et rassure : adresse de téléchargement, installation à la main une seule fois, données conservées", () => {
    const flat = readJson("tools/transition/news.json").paragraphs.flat().map((p) => p.text).join("");
    assert.match(flat, /github\.com\/cyrian290606\/CobbleRealm-Launcher\/releases\/latest/, "adresse EXACTE (l'ancien launcher n'a pas de lien cliquable)");
    assert.match(flat, /une seule fois/i);
    assert.match(flat, /à la main/i);
    assert.match(flat, /conserv/i);
    assert.match(flat, /Informations complémentaires/, "aide pour l'avertissement Windows");
    assert.ok(flat.length < 900, `${flat.length} caractères : trop long pour la carte`);
});

test("Annonces : français simple, aucun terme technique, aucune adresse inventée (seul GitHub officiel et le Discord)", () => {
    const flat = [fs.readFileSync(path.join(ROOT, "tools/transition/news.json"), "utf8"), fs.readFileSync(path.join(ROOT, "tools/transition/ANNONCE-DISCORD.md"), "utf8")].join("\n");
    for (const forbidden of [/SHA-?256/i, /manifest/i, /\bAPI\b/, /ed25519/i, /electron/i, /token/i, /\.js\b/, /localhost|127\.0\.0\.1/]) assert.doesNotMatch(flat, forbidden, String(forbidden));
    const urls = [...flat.matchAll(/https?:\/\/[^\s"')]+|github\.com\/[^\s"')]+/g)].map((m) => m[0]);
    for (const u of urls) assert.match(u, /github\.com\/cyrian290606\/CobbleRealm-Launcher\/releases\/latest/, `adresse inattendue : ${u}`);
});

test("Le launcher 2.0 lit SON fichier d'annonces (news-2.json) : les joueurs 2.0 ne voient jamais l'annonce de transition", () => {
    const main = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
    assert.match(main, /CobbleRealm-Launcher\/main\/news-2\.json/);
    assert.doesNotMatch(main, /CobbleRealm-Launcher\/main\/news\.json/, "plus de lecture de l'annonce destinée aux anciens launchers");
});

test("Le modèle d'annonces du launcher 2.0 est valide", () => {
    const news = normalizeLegacyNews(readJson("tools/transition/news-2.json"), FALLBACK);
    assert.strictEqual(news.usedFallbackParagraphs, false);
});

(async () => {
    let failed = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`  OK    ${name}`); }
        catch (error) { failed++; console.log(`  ECHEC ${name}\n        ${String(error.stack || error).split("\n").slice(0, 4).join("\n        ")}`); }
    }
    console.log(failed ? `\n${failed} test(s) en échec` : "\nTous les tests passent");
    process.exit(failed ? 1 : 0);
})();
