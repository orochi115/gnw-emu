import { test, expect } from "vitest";
import { FrameParser } from "../../src/display/frame-parser";
import { LatestDelivery } from "../../src/display/delivery";
import {
  encodeHeader,
  MessageType,
  MAX_FRAME_BYTES,
} from "../../src/shared/frame-protocol";
test("fragmented headers and payload decode once; backwards frames reject", () => {
  const messages: any[] = [];
  const parser = new FrameParser((m) => messages.push(m));
  const hello = encodeHeader({
    type: MessageType.Hello,
    pixelFormat: 1,
    maxFrameBytes: MAX_FRAME_BYTES,
  });
  const frame = encodeHeader({
    type: MessageType.Frame,
    sequence: 1n,
    width: 1,
    height: 1,
    stride: 4,
    pixelFormat: 1,
    payloadBytes: 4,
  });
  const stream = Buffer.concat([hello, frame, Buffer.from([1, 2, 3, 255])]);
  for (const b of stream) parser.push(Buffer.from([b]));
  expect(messages).toHaveLength(2);
  expect([...messages[1].pixels]).toEqual([1, 2, 3, 255]);
  expect(() => parser.push(Buffer.concat([frame, Buffer.alloc(4)]))).toThrow(
    /sequence/,
  );
});
test("slow renderer has one in flight and replaces pending with newest frame", () => {
  const sent: number[] = [];
  const delivery = new LatestDelivery<number>((v) => sent.push(v));
  for (let i = 1; i <= 50; i++) delivery.offer(i);
  expect(sent).toEqual([1]);
  expect(delivery.queued).toBe(2);
  delivery.consumed();
  expect(sent).toEqual([1, 50]);
  delivery.consumed();
  expect(delivery.queued).toBe(0);
});

test("handshake limit and truncated packets reject before delivery", () => {
  const parser = new FrameParser(() => {});
  parser.push(
    encodeHeader({ type: MessageType.Hello, pixelFormat: 1, maxFrameBytes: 1 }),
  );
  expect(() =>
    parser.push(
      encodeHeader({
        type: MessageType.Frame,
        sequence: 1n,
        width: 1,
        height: 1,
        stride: 4,
        pixelFormat: 1,
        payloadBytes: 4,
      }),
    ),
  ).toThrow(/limit/);
  const incomplete = new FrameParser(() => {});
  incomplete.push(Buffer.from([1, 2]));
  expect(() => incomplete.end()).toThrow(/Truncated/);
});
