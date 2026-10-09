// Deterministic Ogg Opus writer for the Channels live proof (no dependencies).
// It writes a mono, 48 kHz Opus stream of digital silence. Each 20 ms packet is the CELT silence frame
// (TOC 0xF8, payload 0xFF 0xFE) that libopus itself emits for silence, so every Opus decoder accepts it
// and Telegram plays the file as a voice note.

const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 0x80000000 ? ((value << 1) ^ 0x04c11db7) >>> 0 : (value << 1) >>> 0;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** Ogg page checksum: CRC-32, polynomial 0x04C11DB7, MSB first, initial value 0, no final xor. */
export function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  }
  return crc >>> 0;
}

const FLAG_BOS = 0x02;
const FLAG_EOS = 0x04;

function page(input: { flags: number; granule: bigint; serial: number; sequence: number; packets: Uint8Array[] }): Uint8Array {
  const lacing: number[] = [];
  for (const packet of input.packets) {
    let remaining = packet.length;
    while (remaining >= 255) {
      lacing.push(255);
      remaining -= 255;
    }
    lacing.push(remaining);
  }
  if (lacing.length > 255) throw new Error("ogg_page_too_many_segments");
  const body = Buffer.concat(input.packets);
  const header = Buffer.alloc(27 + lacing.length);
  header.write("OggS", 0, "latin1");
  header.writeUInt8(0, 4);
  header.writeUInt8(input.flags, 5);
  header.writeBigUInt64LE(input.granule, 6);
  header.writeUInt32LE(input.serial, 14);
  header.writeUInt32LE(input.sequence, 18);
  header.writeUInt32LE(0, 22);
  header.writeUInt8(lacing.length, 26);
  lacing.forEach((value, index) => header.writeUInt8(value, 27 + index));
  const whole = Buffer.concat([header, body]);
  whole.writeUInt32LE(oggCrc(whole), 22);
  return whole;
}

const OPUS_PRE_SKIP = 312;
const SAMPLES_PER_PACKET = 960; // 20 ms at 48 kHz
const SILENCE_PACKET = Uint8Array.from([0xf8, 0xff, 0xfe]);

/** Ogg Opus bytes of digital silence. The default of 51 packets is 1.01 s after the pre-skip. */
export function buildSilenceOpus(packetCount = 51): Uint8Array {
  if (!Number.isInteger(packetCount) || packetCount < 1 || packetCount > 255) throw new Error("opus_packet_count_invalid");
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, "latin1");
  head.writeUInt8(1, 8); // version
  head.writeUInt8(1, 9); // mono
  head.writeUInt16LE(OPUS_PRE_SKIP, 10);
  head.writeUInt32LE(48_000, 12); // input sample rate (informational)
  head.writeInt16LE(0, 16); // output gain
  head.writeUInt8(0, 18); // channel mapping family 0
  const vendor = Buffer.from("tealbrick-channels-proof", "latin1");
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write("OpusTags", 0, "latin1");
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length); // no user comments
  const serial = 0x7ea1b21c;
  return Buffer.concat([
    page({ flags: FLAG_BOS, granule: 0n, serial, sequence: 0, packets: [head] }),
    page({ flags: 0, granule: 0n, serial, sequence: 1, packets: [tags] }),
    page({
      flags: FLAG_EOS,
      granule: BigInt(packetCount * SAMPLES_PER_PACKET),
      serial,
      sequence: 2,
      packets: Array.from({ length: packetCount }, () => SILENCE_PACKET),
    }),
  ]);
}
