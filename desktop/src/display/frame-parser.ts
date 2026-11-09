import {
  decodeHeader,
  HEADER_BYTES,
  MessageType,
  MAX_FRAME_BYTES,
  type FrameHeader,
} from "../shared/frame-protocol";
export interface WireMessage {
  header: FrameHeader;
  pixels: Uint8Array;
}
/** Retains at most one incomplete packet. Header validation precedes allocation. */
export class FrameParser {
  private buffer = Buffer.alloc(0);
  private hello = false;
  private limit = MAX_FRAME_BYTES;
  private sequence = 0n;
  constructor(private emit: (message: WireMessage) => void) {}
  push(chunk: Uint8Array) {
    if (
      this.buffer.length + chunk.length >
      MAX_FRAME_BYTES + HEADER_BYTES + 65536
    )
      throw new Error("Display buffer overflow");
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= HEADER_BYTES) {
      const header = decodeHeader(this.buffer.subarray(0, HEADER_BYTES));
      if (header.type === MessageType.Hello) {
        if (this.hello) throw new Error("Duplicate handshake");
        this.hello = true;
        this.limit = header.maxFrameBytes;
      } else if (header.type !== MessageType.Frame || !this.hello)
        throw new Error("Invalid display handshake order");
      if (header.payloadBytes > this.limit)
        throw new Error("Negotiated frame limit exceeded");
      const length = HEADER_BYTES + header.payloadBytes;
      if (this.buffer.length < length) return;
      if (header.type === MessageType.Frame) {
        if (header.sequence <= this.sequence)
          throw new Error("Invalid frame sequence");
        this.sequence = header.sequence;
      }
      const pixels = Uint8Array.from(
        this.buffer.subarray(HEADER_BYTES, length),
      );
      this.buffer = this.buffer.subarray(length);
      this.emit({ header, pixels });
    }
  }
  end() {
    if (this.buffer.length) throw new Error("Truncated display message");
  }
}
