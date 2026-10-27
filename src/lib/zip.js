'use strict';
/*
 * Minimal ZIP writer (stored, no compression) — enough for packaging an extension.
 * Layout: [local header + name + data] per file, then the central directory, then
 * the end-of-central-directory record. All integers are little-endian.
 */

/*
 * crc_table_create() -> the 256-entry CRC-32 lookup table
 */
function crc_table_create() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return table;
}
const CRC_TABLE = crc_table_create();

/*
 * crc32(bytes) -> CRC-32 checksum of bytes
 */
function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

/*
 * zip(files, date) -> Uint8Array holding a .zip of files ({ path, content: string | Uint8Array })
 */
export function zip(files, date) {
    const when = date || new Date();
    const enc = new TextEncoder();
    const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
    const day = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
    const parts = [];
    const centrals = [];
    let offset = 0;

    for (const file of files) {
        const name = enc.encode(file.path);
        const data = typeof file.content === 'string' ? enc.encode(file.content) : file.content;
        const crc = crc32(data);

        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);
        local.setUint16(6, 0x0800, true); // UTF-8 names
        local.setUint16(10, time, true);
        local.setUint16(12, day, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, data.length, true);
        local.setUint32(22, data.length, true);
        local.setUint16(26, name.length, true);
        parts.push(new Uint8Array(local.buffer), name, data);

        const central = new DataView(new ArrayBuffer(46));
        central.setUint32(0, 0x02014b50, true);
        central.setUint16(4, 20, true);
        central.setUint16(6, 20, true);
        central.setUint16(8, 0x0800, true);
        central.setUint16(12, time, true);
        central.setUint16(14, day, true);
        central.setUint32(16, crc, true);
        central.setUint32(20, data.length, true);
        central.setUint32(24, data.length, true);
        central.setUint16(28, name.length, true);
        central.setUint32(42, offset, true);
        centrals.push(new Uint8Array(central.buffer), name);

        offset += 30 + name.length + data.length;
    }

    let directory_size = 0;
    for (const part of centrals) {
        directory_size += part.length;
        parts.push(part);
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, directory_size, true);
    end.setUint32(16, offset, true);
    parts.push(new Uint8Array(end.buffer));

    let total = 0;
    for (const part of parts) {
        total += part.length;
    }
    const out = new Uint8Array(total);
    let pos = 0;
    for (const part of parts) {
        out.set(part, pos);
        pos += part.length;
    }
    return out;
}
