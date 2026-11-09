/** GNWF v1. Wire integers are little-endian; bytes are RGBA, never native structs. */
export const HEADER_BYTES = 64;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export enum MessageType {
  Hello = 1,
  HelloAck = 2,
  Frame = 3,
  FrameAck = 4,
}
export interface FrameHeader {
  type: MessageType;
  payloadBytes: number;
  sequence: bigint;
  captureTimeNs: bigint;
  width: number;
  height: number;
  stride: number;
  pixelFormat: number;
  maxFrameBytes: number;
}
export function encodeHeader(
  input: Partial<FrameHeader> & Pick<FrameHeader, "type">,
): Uint8Array {
  const bytes = new Uint8Array(HEADER_BYTES);
  bytes.set([0x47, 0x4e, 0x57, 0x46]);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 1, true);
  view.setUint16(6, input.type, true);
  view.setUint32(8, HEADER_BYTES, true);
  view.setUint32(12, input.payloadBytes ?? 0, true);
  view.setBigUint64(16, input.sequence ?? 0n, true);
  view.setBigUint64(24, input.captureTimeNs ?? 0n, true);
  for (const [offset, value] of [
    [32, input.width],
    [36, input.height],
    [40, input.stride],
    [44, input.pixelFormat],
    [48, input.maxFrameBytes],
  ] as const)
    view.setUint32(offset, value ?? 0, true);
  return bytes;
}
export function decodeHeader(bytes: Uint8Array): FrameHeader {
  if (bytes.byteLength !== HEADER_BYTES)
    throw new Error("Invalid frame header length");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    v.getUint32(0, true) !== 0x46574e47 ||
    v.getUint16(4, true) !== 1 ||
    v.getUint32(8, true) !== HEADER_BYTES
  )
    throw new Error("Invalid frame header magic/version");
  if (v.getUint32(52, true) || v.getBigUint64(56, true))
    throw new Error("Nonzero reserved header bytes");
  const h: FrameHeader = {
    type: v.getUint16(6, true),
    payloadBytes: v.getUint32(12, true),
    sequence: v.getBigUint64(16, true),
    captureTimeNs: v.getBigUint64(24, true),
    width: v.getUint32(32, true),
    height: v.getUint32(36, true),
    stride: v.getUint32(40, true),
    pixelFormat: v.getUint32(44, true),
    maxFrameBytes: v.getUint32(48, true),
  };
  if (![1, 2, 3, 4].includes(h.type))
    throw new Error("Unknown frame message type");
  if (h.type === MessageType.Frame) {
    if (
      !h.sequence ||
      !h.width ||
      !h.height ||
      h.width > 2048 ||
      h.height > 2048 ||
      h.stride !== h.width * 4 ||
      h.maxFrameBytes
    )
      throw new Error("Invalid frame dimensions");
    if (
      h.payloadBytes !== h.stride * h.height ||
      h.payloadBytes > MAX_FRAME_BYTES
    )
      throw new Error("Invalid frame payload length");
    if (h.pixelFormat !== 1) throw new Error("Unsupported pixel format");
  } else {
    if (h.payloadBytes || h.width || h.height || h.stride || h.captureTimeNs)
      throw new Error("Malformed handshake/ack header");
    if (h.type === MessageType.FrameAck) {
      if (!h.sequence || h.pixelFormat || h.maxFrameBytes)
        throw new Error("Malformed frame ack");
    } else if (
      h.sequence ||
      h.pixelFormat !== 1 ||
      !h.maxFrameBytes ||
      h.maxFrameBytes > MAX_FRAME_BYTES
    )
      throw new Error("Invalid handshake format/limit");
  }
  return h;
}
