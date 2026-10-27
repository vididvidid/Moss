'use strict';
/*
 * Generates the Moss icons (no dependencies): node tools/make-icons.mjs
 * Writes RGBA PNGs by hand: signature, IHDR, one zlib-compressed IDAT, IEND.
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

/*
 * crc_table_create() -> the 256-entry CRC-32 lookup table
 */
function crc_table_create() {
    const table = [];
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table.push(c >>> 0);
    }
    return table;
}
const CRC_TABLE = crc_table_create();

/*
 * crc32(buf) -> CRC-32 of buf
 */
function crc32(buf) {
    let c = ~0;
    for (const byte of buf) {
        c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    }
    return ~c >>> 0;
}

/*
 * chunk(type, data) -> one PNG chunk: length, type, data, CRC
 */
function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

/*
 * pixel(size, x, y) -> [r, g, b, a] of the leaf icon at (x, y)
 */
function pixel(size, x, y) {
    const r = size * 0.22; // corner radius
    const cx = Math.min(Math.max(x + 0.5, r), size - r);
    const cy = Math.min(Math.max(y + 0.5, r), size - r);
    const inside = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r;
    // leaf: two overlapping circles, with a vein along the diagonal
    const u = (x + 0.5) / size;
    const v = (y + 0.5) / size;
    const leaf = Math.hypot(u - 0.36, v - 0.36) < 0.42 && Math.hypot(u - 0.64, v - 0.64) < 0.42;
    const vein = leaf && Math.abs(u - v) < 0.035;
    let rgb = [74, 124, 52];
    if (vein) {
        rgb = [46, 82, 34];
    } else if (leaf) {
        rgb = [214, 236, 190];
    }
    return [rgb[0], rgb[1], rgb[2], inside ? 255 : 0];
}

/*
 * png(size) -> Buffer holding a size×size PNG
 */
function png(size) {
    const row = size * 4 + 1;
    const raw = Buffer.alloc(size * row);
    for (let y = 0; y < size; y++) {
        raw[y * row] = 0; // filter: none
        for (let x = 0; x < size; x++) {
            const p = pixel(size, x, y);
            const i = y * row + 1 + x * 4;
            raw[i] = p[0];
            raw[i + 1] = p[1];
            raw[i + 2] = p[2];
            raw[i + 3] = p[3];
        }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8; // bit depth
    header[9] = 6; // RGBA
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const size of [16, 48, 128]) {
    writeFileSync(new URL(`../icons/icon${size}.png`, import.meta.url), png(size));
}
