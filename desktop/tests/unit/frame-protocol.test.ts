import { describe, expect, test } from "vitest";
import {
  decodeHeader,
  encodeHeader,
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  MessageType,
} from "../../src/shared/frame-protocol";

describe("frame wire contract", () => {
  test("encodes the documented hello bytes independent of native struct layout", () => {
    const bytes = encodeHeader({
      type: MessageType.Hello,
      pixelFormat: 1,
      maxFrameBytes: MAX_FRAME_BYTES,
    });
    expect(bytes.byteLength).toBe(64);
    expect(Buffer.from(bytes).subarray(0, 16).toString("hex")).toBe(
      "474e5746010001004000000000000000",
    );
    expect(decodeHeader(bytes).maxFrameBytes).toBe(16 * 1024 * 1024);
  });
  test("retains frame numbers beyond Number precision", () => {
    const sequence = 9007199254740993n;
    const header = decodeHeader(
      encodeHeader({
        type: MessageType.Frame,
        sequence,
        captureTimeNs: 8n,
        width: 320,
        height: 240,
        stride: 1280,
        payloadBytes: 307200,
        pixelFormat: 1,
      }),
    );
    expect(header.sequence).toBe(sequence);
  });
  test("rejects lengths and formats before allocating a payload", () => {
    const valid = encodeHeader({
      type: MessageType.Frame,
      sequence: 1n,
      width: 1,
      height: 1,
      stride: 4,
      payloadBytes: 4,
      pixelFormat: 1,
    });
    const bad = Buffer.from(valid);
    bad.writeUInt32LE(0xffffffff, 12);
    expect(() => decodeHeader(bad)).toThrow(/payload/i);
    bad.set(valid);
    bad.writeUInt32LE(2, 44);
    expect(() => decodeHeader(bad)).toThrow(/format/i);
    expect(() => decodeHeader(valid.subarray(0, HEADER_BYTES - 1))).toThrow(
      /header/i,
    );
  });
  test("rejects nonzero reserved bytes and malformed acknowledgements", () => {
    const bad = Buffer.from(
      encodeHeader({ type: MessageType.FrameAck, sequence: 1n }),
    );
    bad[63] = 1;
    expect(() => decodeHeader(bad)).toThrow(/reserved/i);
    bad[63] = 0;
    bad.writeUInt32LE(1, 32);
    expect(() => decodeHeader(bad)).toThrow(/ack/i);
  });
});
