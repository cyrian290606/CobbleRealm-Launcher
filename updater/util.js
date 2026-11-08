"use strict";

const fs = require("fs");
const crypto = require("crypto");

function hashFile(filePath) {

    return new Promise((resolve, reject) => {

        const hash = crypto.createHash("sha256");
        const stream = fs.createReadStream(filePath);

        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("error", reject);
        stream.on("end", () => resolve(hash.digest("hex")));
    });
}

async function mapLimit(items, limit, fn) {

    const results = new Array(items.length);
    let next = 0;

    async function worker() {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    }

    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
    return results;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { hashFile, mapLimit, sleep };
