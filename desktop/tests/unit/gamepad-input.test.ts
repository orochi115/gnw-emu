import { describe, expect, it } from "vitest";
import {
  GamepadInputReader,
  gamepadFingerprint,
  type GamepadSnapshot,
} from "../../src/renderer/hooks/gamepad-input";
import { defaultControls } from "../../src/shared/controls";
const pad = (
  index = 0,
  id = "controller",
  axis = 0,
  pressed = false,
): GamepadSnapshot => ({
  index,
  id,
  mapping: "standard",
  connected: true,
  axes: [axis, 0],
  buttons: [{ pressed, value: pressed ? 1 : 0 }],
});
describe("gamepad input normalization", () => {
  it("fingerprint follows interface identity rather than connection index", () => {
    expect(gamepadFingerprint(pad(0))).toBe(gamepadFingerprint(pad(3)));
    expect(gamepadFingerprint(pad(0, "bluetooth"))).not.toBe(
      gamepadFingerprint(pad(0, "usb")),
    );
  });
  it("requires neutral before capture and applies hysteresis", () => {
    const reader = new GamepadInputReader();
    const config = defaultControls();
    expect(
      reader.sample([pad(0, "controller", 0.8)], config, 1).events,
    ).toEqual([]);
    reader.sample([pad()], config, 1);
    expect(
      reader.sample([pad(0, "controller", 0.26)], config, 1).events,
    ).toMatchObject([{ down: true, input: { control: "axis", direction: 1 } }]);
    expect(
      reader.sample([pad(0, "controller", 0.22)], config, 1).events,
    ).toEqual([]);
    expect(
      reader.sample([pad(0, "controller", 0.19)], config, 1).events,
    ).toMatchObject([{ down: false }]);
    expect(
      reader.sample([pad(0, "controller", NaN)], config, 1).events,
    ).toEqual([]);
  });
  it("releases disconnected and suspended devices and requires fresh neutral after suspension", () => {
    const reader = new GamepadInputReader();
    const config = defaultControls();
    reader.sample([pad()], config, 1);
    const down = reader.sample([pad(0, "controller", 0, true)], config, 1)
      .events[0];
    expect(down.down).toBe(true);
    expect(reader.suspend(1)).toMatchObject([
      { down: false, source: down.source },
    ]);
    expect(
      reader.sample([pad(0, "controller", 0, true)], config, 1).events,
    ).toEqual([]);
    reader.sample([pad()], config, 1);
    reader.sample([pad(0, "controller", 0, true)], config, 1);
    expect(reader.sample([], config, 1).events).toMatchObject([
      { down: false },
    ]);
  });
  it("labels collisions and discards instance-only disabled state on reconnect", () => {
    const reader = new GamepadInputReader();
    const config = defaultControls();
    const devices = reader.sample([pad(0), pad(1)], config, 1).devices;
    expect(devices.every((device) => device.collision)).toBe(true);
    reader.participate(devices[0].instance, false);
    expect(
      reader.sample([pad(0, "controller", 0, true), pad(1)], config, 1).events,
    ).toEqual([]);
    reader.sample([pad(1)], config, 1);
    const reconnect = reader.sample([pad(0), pad(1)], config, 1).devices;
    expect(
      reconnect.find(
        (device) =>
          device.instance !== devices[0].instance && device.index === 0,
      )?.enabled,
    ).toBe(true);
  });
  it("preserves separate candidate sources when fingerprints collide", () => {
    const reader = new GamepadInputReader();
    const config = defaultControls();
    reader.sample([pad(0), pad(1)], config, 1);
    const events = reader.sample(
      [pad(0, "controller", 0, true), pad(1, "controller", 0, true)],
      config,
      1,
    ).events;
    expect(events).toHaveLength(2);
    expect(events[0].source).not.toBe(events[1].source);
    expect(events[0].input).toEqual(events[1].input);
  });
});

import { ControlRouter } from "../../src/core/control-router";
it("routes a reader two-button chord from one device and rejects cross-device halves", () => {
  const actions: string[] = [];
  const config = defaultControls();
  config.bindings = [
    {
      id: "chord",
      target: "audio.mute",
      inputs: [
        { kind: "gamepad", device: "standard", control: "button", index: 0 },
        { kind: "gamepad", device: "standard", control: "button", index: 1 },
      ],
      modifiers: [],
      turbo: null,
    },
  ];
  const router = new ControlRouter(config, {
    button: () => {},
    action: (id) => {
      actions.push(id);
    },
    release: () => {},
  });
  const reader = new GamepadInputReader();
  const snapshot = (index: number, a: boolean, b: boolean) => ({
    ...pad(index),
    buttons: [
      { pressed: a, value: a ? 1 : 0 },
      { pressed: b, value: b ? 1 : 0 },
    ],
  });
  const feed = (pads: GamepadSnapshot[]) => {
    for (const event of reader.sample(pads, config, router.epoch).events)
      router.event(event);
  };
  feed([snapshot(0, false, false), snapshot(1, false, false)]);
  feed([snapshot(0, true, false), snapshot(1, false, true)]);
  expect(actions).toEqual([]);
  feed([snapshot(0, true, true), snapshot(1, false, true)]);
  expect(actions).toEqual(["audio.mute"]);
  router.dispose();
});

it("transfers participation between readers by connection index and fingerprint, then forgets it on reconnect", () => {
  const game = new GamepadInputReader(),
    settings = new GamepadInputReader();
  const config = defaultControls();
  game.sample([pad(0), pad(1)], config, 1);
  const devices = settings.sample([pad(0), pad(1)], config, 1).devices;
  settings.participate(devices[1].instance, false);
  const committed = settings.sample([pad(0), pad(1)], config, 1).devices;
  game.importParticipation(committed);
  expect(game.participation(config)).toHaveLength(2);
  expect(
    game.sample([pad(0), pad(1)], config, 2).devices.map((d) => d.enabled),
  ).toEqual([true, false]);
  const fresh = new GamepadInputReader();
  fresh.importParticipation(committed);
  fresh.sample([], config, 2);
  expect(
    fresh.sample([pad(0), pad(1)], config, 2).devices.map((d) => d.enabled),
  ).toEqual([true, false]);
  game.sample([], config, 2);
  expect(
    game.sample([pad(0), pad(1)], config, 2).devices.map((d) => d.enabled),
  ).toEqual([true, true]);
});

it("keeps imported selections until each controller appears and exports unseen selections", () => {
  const reader = new GamepadInputReader(),
    config = defaultControls();
  const fingerprint = gamepadFingerprint(pad());
  reader.importParticipation([
    { index: 0, fingerprint, enabled: true },
    { index: 1, fingerprint, enabled: false },
  ]);
  expect(reader.participation(config)).toHaveLength(2);
  reader.sample([pad(0)], config, 1);
  expect(reader.participation(config).find((d) => d.index === 1)?.enabled).toBe(
    false,
  );
  expect(
    reader.sample([pad(0), pad(1)], config, 1).devices.map((d) => d.enabled),
  ).toEqual([true, false]);
  reader.sample([pad(0)], config, 1);
  expect(reader.participation(config)).toHaveLength(1);
});
