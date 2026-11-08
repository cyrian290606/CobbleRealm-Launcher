/*
 * Faux serveur Minecraft (même protocole « Server List Ping » que le vrai), partagé par les tests.
 * La réponse peut être changée à tout moment : server.response = { players: { online, max } }
 */

const net = require("net");
const { readVarInt, writeVarInt } = require("../serverStatus");

function startFakeMinecraft(responseJson, { closeEarly = false, garbage = false } = {}) {

    return new Promise((resolve) => {

        const handle = { response: responseJson, seen: { handshakes: 0, statusRequests: 0 } };

        const server = net.createServer((socket) => {

            let buffer = Buffer.alloc(0);

            socket.on("data", (chunk) => {

                if (closeEarly) return socket.destroy();

                buffer = Buffer.concat([buffer, chunk]);

                const first = readVarInt(buffer, 0);
                if (!first || buffer.length < first.size + first.value) return;
                handle.seen.handshakes = 1;

                const rest = buffer.subarray(first.size + first.value);
                const second = readVarInt(rest, 0);
                if (!second || rest.length < second.size + second.value) return;
                handle.seen.statusRequests = 1;

                if (garbage) return socket.end(Buffer.from([0x05, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));

                const json = Buffer.from(JSON.stringify(handle.response), "utf8");
                const payload = Buffer.concat([writeVarInt(0x00), writeVarInt(json.length), json]);
                socket.write(Buffer.concat([writeVarInt(payload.length), payload]));
            });

            socket.on("error", () => {});
        });

        server.listen(0, "127.0.0.1", () => {
            handle.port = server.address().port;
            handle.seen = handle.seen;
            handle.close = () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
            resolve(handle);
        });
    });
}

module.exports = { startFakeMinecraft };
