"use strict";

/*
 * Statut réel du serveur Minecraft (Java) via le protocole standard « Server List Ping ».
 * Aucune valeur inventée : "online" seulement si le serveur répond réellement.
 *
 *   { state: "online",  players: { online, max } | null }
 *   { state: "offline" }     le serveur ne répond pas alors que le joueur a Internet
 *   { state: "unknown" }     impossible de savoir (le joueur n'a pas Internet)
 */

const net = require("net");
const dns = require("dns");

const DEFAULT_PORT = 25565;

/** "play.exemple.fr", "play.exemple.fr:25570" -> { host, port, explicitPort } ; null si invalide. */
function parseServerAddress(value) {

    if (typeof value !== "string") return null;

    const match = /^([A-Za-z0-9.-]{1,253})(?::(\d{1,5}))?$/.exec(value.trim());

    if (!match) return null;

    const port = match[2] ? Number(match[2]) : DEFAULT_PORT;

    if (port < 1 || port > 65535) return null;

    return { host: match[1], port, explicitPort: Boolean(match[2]) };
}

/* ---------- encodage du protocole ---------- */

function writeVarInt(value) {

    const bytes = [];
    let v = value >>> 0;

    do {
        let byte = v & 0x7f;
        v >>>= 7;
        if (v !== 0) byte |= 0x80;
        bytes.push(byte);
    } while (v !== 0);

    return Buffer.from(bytes);
}

/** Retourne { value, size } ou null si le tampon est incomplet. */
function readVarInt(buffer, offset = 0) {

    let value = 0;
    let size = 0;

    for (;;) {

        if (offset + size >= buffer.length) return null;

        const byte = buffer[offset + size];
        value |= (byte & 0x7f) << (7 * size);
        size++;

        if ((byte & 0x80) === 0) break;
        if (size > 5) throw new Error("VarInt invalide");
    }

    return { value, size };
}

const packet = (payload) => Buffer.concat([writeVarInt(payload.length), payload]);

function buildHandshake(host, port) {

    const hostBuffer = Buffer.from(host, "utf8");
    const portBuffer = Buffer.alloc(2);
    portBuffer.writeUInt16BE(port);

    return packet(Buffer.concat([
        writeVarInt(0x00),                         // identifiant du paquet : handshake
        writeVarInt(767),                          // version du protocole (sans importance pour le statut)
        writeVarInt(hostBuffer.length), hostBuffer,
        portBuffer,
        writeVarInt(1)                             // état suivant : statut
    ]));
}

/** Extrait { online, max } d'une réponse de statut, ou null si le serveur masque les joueurs. */
function extractPlayers(json) {

    const players = json && json.players;

    if (!players || !Number.isInteger(players.online) || !Number.isInteger(players.max) || players.online < 0 || players.max < 0) {
        return null;
    }

    return { online: players.online, max: players.max };
}

/* ---------- requête ---------- */

function pingOnce({ host, port, timeoutMs = 4000, connect = net.connect }) {

    return new Promise((resolve, reject) => {

        const socket = connect({ host, port });
        let received = Buffer.alloc(0);
        let settled = false;

        const finish = (error, value) => {

            if (settled) return;
            settled = true;
            socket.destroy();

            error ? reject(error) : resolve(value);
        };

        socket.setTimeout(timeoutMs, () => finish(Object.assign(new Error("délai dépassé"), { code: "ETIMEDOUT" })));
        socket.on("error", (error) => finish(error));
        socket.on("close", () => finish(Object.assign(new Error("connexion fermée"), { code: "ECONNRESET" })));

        socket.on("connect", () => {
            socket.write(buildHandshake(host, port));
            socket.write(packet(writeVarInt(0x00)));          // demande de statut
        });

        socket.on("data", (chunk) => {

            received = Buffer.concat([received, chunk]);

            if (received.length > 512 * 1024) return finish(new Error("réponse trop volumineuse"));

            try {

                const length = readVarInt(received, 0);
                if (!length) return;

                const total = length.size + length.value;
                if (received.length < total) return;

                const id = readVarInt(received, length.size);
                if (!id || id.value !== 0x00) return finish(new Error("réponse inattendue"));

                const jsonLength = readVarInt(received, length.size + id.size);
                if (!jsonLength) return;

                const start = length.size + id.size + jsonLength.size;
                const json = JSON.parse(received.subarray(start, start + jsonLength.value).toString("utf8"));

                finish(null, json);

            } catch (error) {
                finish(error);
            }
        });
    });
}

/* Le joueur a-t-il Internet ? (sert à ne jamais annoncer « hors ligne » à tort) */
function defaultInternetCheck() {

    return new Promise((resolve) => {
        dns.lookup("github.com", (error) => resolve(!error));
    });
}

/** SRV Minecraft (_minecraft._tcp) : permet d'utiliser un nom de domaine sans port. */
async function resolveTarget(address, resolveSrv = dns.promises.resolveSrv) {

    if (address.explicitPort) return { host: address.host, port: address.port };

    try {

        const records = await resolveSrv(`_minecraft._tcp.${address.host}`);

        if (records && records.length) {
            const best = records.sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
            return { host: best.name, port: best.port };
        }

    } catch { /* pas d'enregistrement SRV : adresse directe */ }

    return { host: address.host, port: address.port };
}

/**
 * @param {string} addressText  ex. "play.exemple.fr" ou "play.exemple.fr:25570"
 */
async function getServerStatus(addressText, { timeoutMs = 4000, connect, internetCheck = defaultInternetCheck, resolveSrv } = {}) {

    const address = parseServerAddress(addressText);

    if (!address) return { state: "unknown" };

    const target = await resolveTarget(address, resolveSrv);

    try {

        const json = await pingOnce({ ...target, timeoutMs, connect });

        return { state: "online", players: extractPlayers(json) };

    } catch {

        return (await internetCheck()) ? { state: "offline" } : { state: "unknown" };
    }
}

module.exports = { getServerStatus, parseServerAddress, extractPlayers, readVarInt, writeVarInt, buildHandshake, DEFAULT_PORT };
