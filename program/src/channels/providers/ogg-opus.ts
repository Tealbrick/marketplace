// Pure Ogg/Opus reader for native voice messages (no dependencies, no decoding).
// Ogg framing: RFC 3533. Opus in Ogg: RFC 7845 (OpusHead, OpusTags, granule positions at 48 kHz, pre-skip).
// Opus packet TOC and frame counts: RFC 6716 section 3.1.

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

/** Ogg page checksum: CRC-32, polynomial 0x04C11DB7, MSB first, initial value 0, no final xor (RFC 3533). */
export function oggPageCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc = ((crc << 8) ^ (OGG_CRC_TABLE[((crc >>> 24) ^ byte) & 0xff] as number)) >>> 0;
  }
  return crc >>> 0;
}

const OPUS_RATE = 48_000;
/** Most Ogg pages read; a 10 MiB file of full pages has about 160. */
const MAX_PAGES = 100_000;
/** Most datapoints in a Discord voice waveform. */
export const VOICE_WAVEFORM_MAX_POINTS = 256;
/** Clients sample the waveform at most once per 100 ms (Discord message resource, Voice Messages). */
const WAVEFORM_STEP_SECONDS = 0.1;

export type OggOpusInfo = {
  /** Seconds of audio after the pre-skip, from the last granule position. */
  durationSecs: number;
  channels: number;
  /** Each audio packet: its byte size and its duration in samples at 48 kHz. */
  packets: Array<{ bytes: number; samples: number }>;
};

export type OggOpusResult = { ok: true; info: OggOpusInfo } | { ok: false; reason: string };

/** Samples (48 kHz) of one Opus packet, from its TOC byte and frame count code; 0 when the packet is invalid. */
export function opusPacketSamples(packet: Uint8Array): number {
  if (packet.length === 0) return 0;
  const toc = packet[0] as number;
  const config = toc >> 3;
  // Frame size per configuration (RFC 6716 table 2), in samples at 48 kHz.
  let frame: number;
  if (config < 12) {
    frame = [480, 960, 1920, 2880][config % 4] as number; // SILK: 10, 20, 40, 60 ms
  } else if (config < 16) {
    frame = [480, 960][config % 2] as number; // Hybrid: 10, 20 ms
  } else {
    frame = [120, 240, 480, 960][config % 4] as number; // CELT: 2.5, 5, 10, 20 ms
  }
  const code = toc & 0x03;
  let frames: number;
  if (code === 0) frames = 1;
  else if (code === 1 || code === 2) frames = 2;
  else {
    if (packet.length < 2) return 0;
    frames = (packet[1] as number) & 0x3f;
  }
  const samples = frame * frames;
  // A packet is at most 120 ms (RFC 6716 section 3.2.5).
  return frames === 0 || samples > 5760 ? 0 : samples;
}

/**
 * Reads an Ogg/Opus file: one logical stream, valid page checksums, OpusHead then OpusTags, then audio packets.
 * Never throws. Refuses anything else (a multiplexed or chained file, a missing header, a bad checksum, no audio).
 */
export function readOggOpus(bytes: Uint8Array): OggOpusResult {
  const parsed = parseOggOpus(bytes);
  if (!parsed.ok) return parsed;
  return { ok: true, info: parsed.info };
}

/** One Ogg/Opus file's audio packets (bytes, in order) with the reader's info; the same checks as `readOggOpus`. */
export type OggOpusPacketsResult = { ok: true; info: OggOpusInfo; preSkip: number; packets: Uint8Array[] } | { ok: false; reason: string };

/** Like `readOggOpus`, and also returns each audio packet's bytes (copies; the input is never changed). Never throws. */
export function readOggOpusPackets(bytes: Uint8Array): OggOpusPacketsResult {
  return parseOggOpus(bytes);
}

function parseOggOpus(bytes: Uint8Array): OggOpusPacketsResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const packets: Uint8Array[] = [];
  let pending: Uint8Array[] = [];
  let offset = 0;
  let serial: number | undefined;
  let lastGranule = -1n;
  let pages = 0;
  let ended = false;
  while (offset < bytes.length) {
    if (ended) return { ok: false, reason: "data after the end of the stream" };
    if (pages >= MAX_PAGES) return { ok: false, reason: "too many Ogg pages" };
    if (offset + 27 > bytes.length) return { ok: false, reason: "truncated Ogg page" };
    if (bytes[offset] !== 0x4f || bytes[offset + 1] !== 0x67 || bytes[offset + 2] !== 0x67 || bytes[offset + 3] !== 0x53 || bytes[offset + 4] !== 0) {
      return { ok: false, reason: "not an Ogg page" };
    }
    const flags = bytes[offset + 5] as number;
    const granule = view.getBigInt64(offset + 6, true);
    const pageSerial = view.getUint32(offset + 14, true);
    const crc = view.getUint32(offset + 22, true);
    const segments = bytes[offset + 26] as number;
    const headerEnd = offset + 27 + segments;
    if (headerEnd > bytes.length) return { ok: false, reason: "truncated Ogg page" };
    let bodyLength = 0;
    for (let index = 0; index < segments; index += 1) bodyLength += bytes[offset + 27 + index] as number;
    const pageEnd = headerEnd + bodyLength;
    if (pageEnd > bytes.length) return { ok: false, reason: "truncated Ogg page" };
    // A copy: Node's Buffer#slice is a view, and the checksum field is zeroed below. The input is never changed.
    const page = Uint8Array.from(bytes.subarray(offset, pageEnd));
    page[22] = 0;
    page[23] = 0;
    page[24] = 0;
    page[25] = 0;
    if (oggPageCrc(page) !== crc) return { ok: false, reason: "bad Ogg page checksum" };
    if (pages === 0) {
      if ((flags & 0x02) === 0) return { ok: false, reason: "the first Ogg page is not a stream start" };
      serial = pageSerial;
    } else if (pageSerial !== serial || (flags & 0x02) !== 0) {
      return { ok: false, reason: "more than one Ogg stream" };
    }
    if ((flags & 0x01) !== 0 && pending.length === 0) return { ok: false, reason: "a continued packet without its start" };
    let cursor = headerEnd;
    for (let index = 0; index < segments; index += 1) {
      const size = bytes[offset + 27 + index] as number;
      pending.push(bytes.subarray(cursor, cursor + size));
      cursor += size;
      if (size < 255) {
        const total = pending.reduce((sum, part) => sum + part.length, 0);
        const packet = new Uint8Array(total);
        let at = 0;
        for (const part of pending) {
          packet.set(part, at);
          at += part.length;
        }
        packets.push(packet);
        pending = [];
      }
    }
    if (granule !== -1n) lastGranule = granule;
    if ((flags & 0x04) !== 0) ended = true;
    pages += 1;
    offset = pageEnd;
  }
  if (pages === 0) return { ok: false, reason: "empty file" };
  const head = packets[0];
  const ascii = (packet: Uint8Array | undefined, text: string) =>
    packet !== undefined && packet.length >= text.length && text.split("").every((char, index) => packet[index] === char.charCodeAt(0));
  if (!head || !ascii(head, "OpusHead") || head.length < 19) return { ok: false, reason: "no OpusHead header" };
  if (((head[8] as number) & 0xf0) !== 0) return { ok: false, reason: "unsupported Opus version" };
  const channels = head[9] as number;
  if (channels < 1) return { ok: false, reason: "no audio channels" };
  const preSkip = (head[10] as number) | ((head[11] as number) << 8);
  if (!ascii(packets[1], "OpusTags")) return { ok: false, reason: "no OpusTags header" };
  const audio = packets.slice(2);
  const described: Array<{ bytes: number; samples: number }> = [];
  for (const packet of audio) {
    const samples = opusPacketSamples(packet);
    if (samples === 0) return { ok: false, reason: "an invalid Opus packet" };
    described.push({ bytes: packet.length, samples });
  }
  if (described.length === 0) return { ok: false, reason: "no audio packets" };
  const total = lastGranule - BigInt(preSkip);
  if (lastGranule < 0n || total <= 0n) return { ok: false, reason: "no usable granule position" };
  const durationSecs = Number(total) / OPUS_RATE;
  if (!Number.isFinite(durationSecs) || durationSecs <= 0) return { ok: false, reason: "no usable duration" };
  return { ok: true, info: { durationSecs, channels, packets: described }, preSkip, packets: audio };
}

/**
 * Waveform bytes (0-255), at most 256 points, one per 100 ms or coarser.
 *
 * APPROXIMATION (documented): Discord clients derive the waveform from decoded PCM. Decoding Opus needs a decoder,
 * which this package does not have, so the envelope comes from the Opus packet sizes instead: a VBR encoder spends
 * more bytes on louder and busier audio, and a silent frame is about 3 bytes. Each point is the mean bytes per 20 ms
 * of the packets in its time slot, minus that 3-byte floor, scaled so the loudest slot is 255. Discord says the
 * waveform details are an implementation detail, and the waveform is only a preview.
 */
export function opusWaveform(info: OggOpusInfo): Uint8Array {
  const totalSamples = info.packets.reduce((sum, packet) => sum + packet.samples, 0);
  const seconds = totalSamples / OPUS_RATE;
  const points = Math.max(1, Math.min(VOICE_WAVEFORM_MAX_POINTS, Math.ceil(seconds / WAVEFORM_STEP_SECONDS)));
  const sums = new Float64Array(points);
  const spans = new Float64Array(points);
  let at = 0;
  for (const packet of info.packets) {
    const slot = Math.min(points - 1, Math.floor((at / totalSamples) * points));
    sums[slot] = (sums[slot] as number) + packet.bytes;
    spans[slot] = (spans[slot] as number) + packet.samples;
    at += packet.samples;
  }
  const FLOOR = 3;
  const levels = Array.from(sums, (sum, index) => {
    const span = spans[index] as number;
    return span > 0 ? Math.max(0, (sum / span) * 960 - FLOOR) : 0;
  });
  const peak = Math.max(...levels);
  return Uint8Array.from(levels, (level) => (peak > 0 ? Math.round((level / peak) * 255) : 0));
}

// ---------------------------------------------------------------- Writer (RFC 3533 pages, RFC 7845 headers)

/** Default pre-skip: 312 samples, the usual libopus encoder delay at 48 kHz (RFC 7845 section 4.2). */
export const OPUS_DEFAULT_PRE_SKIP = 312;
/** A page is closed after this many complete audio packets (one second of 20 ms packets) to keep pages small. */
const WRITER_PACKETS_PER_PAGE = 50;
/** Ogg allows at most 255 lacing values (segments) per page (RFC 3533 section 6). */
const OGG_MAX_SEGMENTS = 255;
/** Sanity cap per packet (an Opus packet is at most 120 ms; real ones are far smaller). Larger packets span pages. */
const WRITER_MAX_PACKET_BYTES = 64 * 1024;

export type OggOpusWriteOptions = {
  channels?: number;
  preSkip?: number;
  /** Informational original sample rate written into OpusHead (default 48 000). */
  inputSampleRate?: number;
  /** Logical stream serial number (default: random). */
  serial?: number;
  /** OpusTags vendor string. */
  vendor?: string;
};

/** One page from raw lacing values and body bytes (the caller splits packets into segments). */
function writePage(input: { flags: number; granule: bigint; serial: number; sequence: number; lacing: readonly number[]; body: readonly Uint8Array[] }): Uint8Array {
  if (input.lacing.length > OGG_MAX_SEGMENTS) throw new Error("ogg_page_too_many_segments");
  const bodyLength = input.body.reduce((sum, part) => sum + part.length, 0);
  const page = new Uint8Array(27 + input.lacing.length + bodyLength);
  const view = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  page[4] = 0; // stream structure version
  page[5] = input.flags;
  view.setBigInt64(6, input.granule, true);
  view.setUint32(14, input.serial >>> 0, true);
  view.setUint32(18, input.sequence >>> 0, true);
  // bytes 22..25: checksum, zero while computing it
  page[26] = input.lacing.length;
  page.set(input.lacing, 27);
  let at = 27 + input.lacing.length;
  for (const part of input.body) {
    page.set(part, at);
    at += part.length;
  }
  view.setUint32(22, oggPageCrc(page), true);
  return page;
}

/** Lacing values of one packet: 255 per full segment, then the remainder (0 when the length is a multiple of 255). */
function lacingOf(length: number): number[] {
  const values = new Array<number>(Math.floor(length / 255)).fill(255);
  values.push(length % 255);
  return values;
}

/**
 * Wraps raw Opus packets into one Ogg/Opus file (RFC 7845): page 0 = OpusHead alone (BOS, granule 0), page 1 =
 * OpusTags alone (granule 0), then audio pages filled by segment count (at most 255 lacing values, and closed after
 * 50 complete packets). A packet that does not fit continues on the next page (continued-packet flag 0x01). A
 * page's granule position is the total samples (48 kHz, pre-skip included) of every packet that ENDS on it or
 * before; a page on which no packet ends has granule -1 (RFC 3533 section 6). The last page carries EOS. Each page
 * checksum is the Ogg CRC-32. Throws on an invalid packet (bad TOC, longer than 120 ms, over 64 KiB) or an empty
 * packet list. The result is a new in-memory buffer; nothing is written anywhere.
 */
export function writeOggOpus(packets: readonly Uint8Array[], options: OggOpusWriteOptions = {}): Uint8Array {
  if (packets.length === 0) throw new Error("ogg_opus_no_packets");
  const channels = options.channels ?? 1;
  const preSkip = options.preSkip ?? OPUS_DEFAULT_PRE_SKIP;
  if (!Number.isInteger(channels) || channels < 1 || channels > 2) throw new Error("ogg_opus_channels_unsupported");
  if (!Number.isInteger(preSkip) || preSkip < 0 || preSkip > 0xffff) throw new Error("ogg_opus_pre_skip_invalid");
  const serial = options.serial ?? (Math.floor(Math.random() * 0x1_0000_0000) >>> 0);

  const head = new Uint8Array(19);
  const headView = new DataView(head.buffer);
  head.set(Array.from("OpusHead", (char) => char.charCodeAt(0)), 0);
  head[8] = 1; // version
  head[9] = channels;
  headView.setUint16(10, preSkip, true);
  headView.setUint32(12, options.inputSampleRate ?? OPUS_RATE, true);
  headView.setInt16(16, 0, true); // output gain
  head[18] = 0; // channel mapping family 0 (mono/stereo)

  const vendor = new TextEncoder().encode(options.vendor ?? "tealbrick-marketplace");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  const tagsView = new DataView(tags.buffer);
  tags.set(Array.from("OpusTags", (char) => char.charCodeAt(0)), 0);
  tagsView.setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  tagsView.setUint32(12 + vendor.length, 0, true); // no user comments

  const pages: Uint8Array[] = [];
  let sequence = 0;
  pages.push(writePage({ flags: 0x02, granule: 0n, serial, sequence: sequence++, lacing: lacingOf(head.length), body: [head] }));
  pages.push(writePage({ flags: 0x00, granule: 0n, serial, sequence: sequence++, lacing: lacingOf(tags.length), body: [tags] }));

  for (const packet of packets) {
    if (!(packet instanceof Uint8Array) || packet.length === 0 || packet.length > WRITER_MAX_PACKET_BYTES || opusPacketSamples(packet) === 0) {
      throw new Error("ogg_opus_packet_invalid");
    }
  }

  // Audio pages. `continued`: the page starts inside a packet begun on the previous page.
  let granule = 0n;
  let lacing: number[] = [];
  let body: Uint8Array[] = [];
  let ended = 0;
  let pageGranule = -1n;
  let continued = false;
  const flush = (last: boolean) => {
    pages.push(writePage({ flags: (continued ? 0x01 : 0) | (last ? 0x04 : 0), granule: pageGranule, serial, sequence: sequence++, lacing, body }));
    lacing = [];
    body = [];
    ended = 0;
    pageGranule = -1n;
  };
  packets.forEach((packet, index) => {
    const values = lacingOf(packet.length);
    let offset = 0;
    for (let segment = 0; segment < values.length; segment += 1) {
      if (lacing.length === OGG_MAX_SEGMENTS) {
        flush(false);
        // The packet goes on: the next page starts with its remaining segments.
        continued = segment > 0;
      } else if (segment === 0 && lacing.length === 0) {
        continued = false;
      }
      const size = values[segment]!;
      lacing.push(size);
      body.push(packet.subarray(offset, offset + size));
      offset += size;
    }
    granule += BigInt(opusPacketSamples(packet));
    pageGranule = granule;
    ended += 1;
    const last = index === packets.length - 1;
    if (last) flush(true);
    else if (ended >= WRITER_PACKETS_PER_PAGE) {
      flush(false);
      continued = false;
    }
  });
  const total = pages.reduce((sum, page) => sum + page.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const page of pages) {
    out.set(page, at);
    at += page.length;
  }
  return out;
}
