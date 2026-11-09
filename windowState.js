"use strict";

/*
 * Mémorisation de la taille et de la position de la fenêtre.
 *
 * Protections : un fichier abîmé est ignoré, une taille absurde est refusée, et une fenêtre dont la position
 * n'est plus visible (écran débranché, résolution changée) revient au centre au lieu de rester introuvable.
 */

const fs = require("fs");
const path = require("path");
const { renameRetrySync } = require("./updater/util");

const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;
const MAX_SIZE = 10000;
const MAX_COORDINATE = 30000;
const MIN_VISIBLE_WIDTH = 100;
const MIN_VISIBLE_HEIGHT = 50;

const DEFAULT_SIZE = { width: 1200, height: 700 };

const isInt = (value) => Number.isFinite(value) && Math.abs(value) < 1e9;

/** Contenu valide ou null. */
function sanitizeState(data) {

    if (!data || typeof data !== "object") return null;

    const width = Math.round(Number(data.width));
    const height = Math.round(Number(data.height));

    if (!isInt(width) || !isInt(height) || width < MIN_WIDTH || height < MIN_HEIGHT || width > MAX_SIZE || height > MAX_SIZE) {
        return null;
    }

    const state = { width, height, maximized: data.maximized === true };

    const x = Math.round(Number(data.x));
    const y = Math.round(Number(data.y));

    if (data.x !== undefined && data.y !== undefined && isInt(x) && isInt(y) && Math.abs(x) <= MAX_COORDINATE && Math.abs(y) <= MAX_COORDINATE) {
        state.x = x;
        state.y = y;
    }

    return state;
}

function readState(file) {

    try {
        return sanitizeState(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
        return null;
    }
}

function writeState(file, state) {

    const clean = sanitizeState(state);

    if (!clean) return false;

    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(clean), "utf8");
        renameRetrySync(`${file}.tmp`, file);
        return true;
    } catch {
        return false;
    }
}

function overlap(a, b) {

    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);

    return { width: Math.max(0, width), height: Math.max(0, height) };
}

/**
 * Taille et position à utiliser à l'ouverture.
 * @param {object|null} saved     état lu (ou null)
 * @param {Array<{workArea:{x,y,width,height}}>} displays  écrans actuellement branchés
 * @returns {{width, height, x?, y?, maximized}}
 */
function restoreBounds(saved, displays = [], defaults = DEFAULT_SIZE) {

    const workAreas = (displays || []).map((d) => d.workArea).filter(Boolean);

    const result = {
        width: saved ? saved.width : defaults.width,
        height: saved ? saved.height : defaults.height,
        maximized: Boolean(saved && saved.maximized)
    };

    if (saved && saved.x !== undefined && saved.y !== undefined && workAreas.length) {

        const bounds = { x: saved.x, y: saved.y, width: saved.width, height: saved.height };

        /* position conservée seulement si une partie utile de la fenêtre est visible sur un écran branché */
        const visibleOn = workAreas.find((area) => {
            const o = overlap(bounds, area);
            return o.width >= MIN_VISIBLE_WIDTH && o.height >= MIN_VISIBLE_HEIGHT;
        });

        if (visibleOn) {
            result.x = saved.x;
            result.y = saved.y;
        }

        /* jamais plus grande que l'écran où elle s'affiche */
        const target = visibleOn || workAreas[0];

        result.width = Math.max(MIN_WIDTH, Math.min(result.width, target.width));
        result.height = Math.max(MIN_HEIGHT, Math.min(result.height, target.height));

    } else if (workAreas.length) {

        result.width = Math.max(MIN_WIDTH, Math.min(result.width, workAreas[0].width));
        result.height = Math.max(MIN_HEIGHT, Math.min(result.height, workAreas[0].height));
    }

    return result;
}

module.exports = { sanitizeState, readState, writeState, restoreBounds, MIN_WIDTH, MIN_HEIGHT, DEFAULT_SIZE };
