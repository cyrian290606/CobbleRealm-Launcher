/*
 * Garde-fou de performance des animations : analyse du CSS de l'interface.
 * Lancer avec : node test/animations.test.js
 *
 * Règles : les animations ne touchent que transform et opacity (jamais la taille, la position,
 * les marges ou le flou), les transitions n'utilisent jamais "all" ni une propriété de mise en page,
 * le nombre d'animations infinies reste très limité, et l'option « réduire les animations » existe.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* blocs @keyframes : { nom: [propriétés utilisées] } */
function keyframes() {

    const result = {};
    const re = /@keyframes\s+([\w-]+)\s*\{/g;
    let m;

    while ((m = re.exec(css))) {

        let depth = 1, i = re.lastIndex;

        while (depth > 0 && i < css.length) {
            if (css[i] === "{") depth++;
            if (css[i] === "}") depth--;
            i++;
        }

        const body = css.slice(re.lastIndex, i - 1);
        const props = new Set();

        for (const declaration of body.matchAll(/([a-z-]+)\s*:\s*[^;}]+/g)) props.add(declaration[1]);

        result[m[1]] = [...props];
    }

    return result;
}

test("Animations : uniquement transform et opacity (jamais taille, position, marges, flou)", () => {
    const all = keyframes();
    const names = Object.keys(all);
    assert.ok(names.length >= 6, "animations trouvées : " + names.join(", "));
    for (const [name, props] of Object.entries(all)) {
        const forbidden = props.filter((p) => !["transform", "opacity"].includes(p));
        assert.deepStrictEqual(forbidden, [], `@keyframes ${name} anime ${forbidden.join(", ")}`);
    }
});

test("Animations : chaque animation utilisée existe, et il y en a très peu d'infinies", () => {
    const defined = new Set(Object.keys(keyframes()));
    const used = [...css.matchAll(/animation:\s*([^;]+);/g)].map((m) => m[1].trim());
    assert.ok(used.length >= 8);
    for (const declaration of used) {
        const name = declaration.split(/\s+/).find((t) => /^cr-/.test(t));
        assert.ok(name && defined.has(name), `animation inconnue : ${declaration}`);
    }
    const infinite = used.filter((d) => /\binfinite\b/.test(d) && !/0\.001ms/.test(d));
    assert.ok(infinite.length <= 4, `trop d'animations infinies (${infinite.length}) : ${infinite.join(" | ")}`);
});

test("Transitions : jamais « all », jamais de durée seule, jamais de propriété de mise en page", () => {
    const ALLOWED = new Set(["background-color", "border-color", "color", "box-shadow", "transform", "filter", "opacity"]);
    const found = [...css.matchAll(/(?<![-\w])transition:\s*([^;]+);/g)].map((m) => m[1].trim()).filter((v) => !/^(none|0\.001ms)/.test(v));
    assert.ok(found.length >= 15, "transitions trouvées : " + found.length);
    for (const declaration of found) {
        for (const part of declaration.split(",")) {
            const property = part.trim().split(/\s+/)[0];
            assert.ok(ALLOWED.has(property), `transition interdite « ${part.trim()} » dans « ${declaration} »`);
        }
    }
    assert.ok(!/transition-property:\s*(all|width|height|top|left|margin|padding)/.test(css));
});

test("Réduire les animations : règle globale présente, avec l'indicateur de chargement conservé", () => {
    assert.match(css, /html\[data-motion="reduce"\] \*,\s*html\[data-motion="reduce"\] \*::before,\s*html\[data-motion="reduce"\] \*::after\s*\{[^}]*animation-duration:\s*0\.001ms\s*!important[^}]*transition-duration:\s*0\.001ms\s*!important/);
    assert.match(css, /html\[data-motion="reduce"\] \.play-spinner/);
    assert.match(html, /function applyMotionSetting\(value\)/);
    assert.match(html, /prefers-reduced-motion: reduce/);
});

test("Barre de progression : animée par transformation, plus par largeur", () => {
    assert.match(css, /\.progress-fill\s*\{[^}]*transform:\s*scaleX\(0\)/);
    assert.ok(!/\.progress-fill\s*\{[^}]*transition:\s*width/.test(css));
    assert.ok(!/updateBar\.style\.width/.test(html), "plus d'écriture directe de la largeur");
});

(async () => {
    let failed = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`  OK    ${name}`); }
        catch (error) { failed++; console.log(`  ECHEC ${name}\n        ${String(error.message).split("\n")[0]}`); }
    }
    console.log(failed ? `\n${failed} test(s) en échec` : "\nTous les tests passent");
    process.exit(failed ? 1 : 0);
})();
