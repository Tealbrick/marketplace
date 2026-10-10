import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { oggPageCrc, readOggOpus, readOggOpusPackets, writeOggOpus } from "../providers/ogg-opus.js";

import { opusPacket } from "./test-support.js";

type Page = { flags: number; granule: bigint; serial: number; sequence: number; crcOk: boolean; segments: number[] };

function pages(bytes: Uint8Array): Page[] {
  const out: Page[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.length) {
    const count = bytes[offset + 26]!;
    const segments = [...bytes.subarray(offset + 27, offset + 27 + count)];
    const end = offset + 27 + count + segments.reduce((sum, value) => sum + value, 0);
    const copy = Uint8Array.from(bytes.subarray(offset, end));
    const crc = view.getUint32(offset + 22, true);
    copy.fill(0, 22, 26);
    out.push({ flags: bytes[offset + 5]!, granule: view.getBigInt64(offset + 6, true), serial: view.getUint32(offset + 14, true), sequence: view.getUint32(offset + 18, true), crcOk: oggPageCrc(copy) === crc, segments });
    offset = end;
  }
  return out;
}

const ffprobe = spawnSync("ffprobe", ["-version"], { encoding: "utf8" }).status === 0;

describe("Ogg/Opus writer", () => {
  it("writes OpusHead/OpusTags pages and audio pages the reader accepts, with valid CRCs and granules", () => {
    const packets = Array.from({ length: 120 }, (_unused, index) => opusPacket(index, 20 + (index % 7)));
    const ogg = writeOggOpus(packets, { serial: 0xdeadbeef });
    const read = readOggOpusPackets(ogg);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.packets.map((packet) => Buffer.from(packet).toString("hex"))).toEqual(packets.map((packet) => Buffer.from(packet).toString("hex")));
    expect(read.preSkip).toBe(312);
    expect(read.info.channels).toBe(1);
    expect(read.info.durationSecs).toBeCloseTo((120 * 960 - 312) / 48_000, 6);

    const list = pages(ogg);
    expect(list.every((page) => page.crcOk && page.serial === 0xdeadbeef)).toBe(true);
    expect(list.map((page) => page.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(list[0]).toMatchObject({ flags: 0x02, granule: 0n });
    expect(list[1]).toMatchObject({ flags: 0x00, granule: 0n });
    // 50 packets per page: granule = samples of all completed packets (pre-skip included).
    expect(list.slice(2).map((page) => page.granule)).toEqual([48_000n, 96_000n, 115_200n]);
    expect(list.slice(2).map((page) => page.flags)).toEqual([0, 0, 0x04]);
  });

  it("laces packets of 255 and 510 bytes with a terminating zero segment", () => {
    const ogg = writeOggOpus([opusPacket(1, 255), opusPacket(2, 510), opusPacket(3, 3)]);
    const audio = pages(ogg)[2]!;
    expect(audio.segments).toEqual([255, 0, 255, 255, 0, 3]);
    const read = readOggOpusPackets(ogg);
    expect(read.ok && read.packets.map((packet) => packet.length)).toEqual([255, 510, 3]);
  });

  it("refuses empty input and invalid Opus packets", () => {
    expect(() => writeOggOpus([])).toThrow("ogg_opus_no_packets");
    expect(() => writeOggOpus([new Uint8Array(0)])).toThrow("ogg_opus_packet_invalid");
    // TOC code 3 with a zero frame count is not a valid packet.
    expect(() => writeOggOpus([Uint8Array.from([0xfb, 0x00])])).toThrow("ogg_opus_packet_invalid");
    expect(() => writeOggOpus([opusPacket(1)], { channels: 3 })).toThrow("ogg_opus_channels_unsupported");
  });

  it("keeps readOggOpus results unchanged for the voice-message path", () => {
    const result = readOggOpus(writeOggOpus([opusPacket(1, 10), opusPacket(2, 30)]));
    expect(result).toEqual({ ok: true, info: { durationSecs: (1920 - 312) / 48_000, channels: 1, packets: [{ bytes: 10, samples: 960 }, { bytes: 30, samples: 960 }] } });
  });

  it.skipIf(!ffprobe)("is accepted by ffprobe (stdin only, nothing written to disk)", () => {
    // F8 FF FE: the well-known CELT 20 ms silence packet, so a decoder can probe it.
    const ogg = writeOggOpus(Array.from({ length: 100 }, () => Uint8Array.from([0xf8, 0xff, 0xfe])));
    const probe = spawnSync("ffprobe", ["-v", "error", "-count_packets", "-show_entries", "stream=codec_name,channels,sample_rate,nb_read_packets:format=format_name", "-of", "json", "-i", "pipe:0"], {
      input: ogg,
      encoding: "utf8",
    });
    expect(probe.status, probe.stderr).toBe(0);
    const info = JSON.parse(probe.stdout) as { streams: Array<Record<string, unknown>>; format: { format_name: string } };
    // A pipe is not seekable, so ffprobe cannot report the duration; it reads and counts every packet instead.
    expect(info.streams[0]).toMatchObject({ codec_name: "opus", channels: 1, sample_rate: "48000", nb_read_packets: "100" });
    expect(info.format.format_name).toBe("ogg");
    expect(probe.stderr).toBe("");
  });
});
