import { expect, it } from "vitest";
import { DeviceParticipationDraft } from "../../src/renderer/components/controls/device-participation";
import {
  GamepadInputReader,
  type GamepadSnapshot,
} from "../../src/renderer/hooks/gamepad-input";
import { defaultControls } from "../../src/shared/controls";
const pad: GamepadSnapshot = {
  index: 0,
  id: "new-controller",
  mapping: "standard",
  connected: true,
  buttons: [{ pressed: false, value: 0 }],
  axes: [0, 0],
};
it("cancel restores a newly connected pad even when current device snapshot is already disabled", () => {
  const reader = new GamepadInputReader(),
    draft = new DeviceParticipationDraft(),
    config = defaultControls();
  const initial = reader.sample([pad], config, 1).devices[0];
  draft.change(initial, false, (instance, enabled) =>
    reader.participate(instance, enabled),
  );
  const live = reader.sample([pad], config, 1).devices;
  expect(live[0].enabled).toBe(false);
  draft.cancel(live, (instance, enabled) =>
    reader.participate(instance, enabled),
  );
  expect(reader.sample([pad], config, 1).devices[0].enabled).toBe(true);
});
it("cancel preserves an existing disabled instance and does not apply old connection state to reconnect", () => {
  const reader = new GamepadInputReader(),
    draft = new DeviceParticipationDraft(),
    config = defaultControls();
  const initial = reader.sample([pad], config, 1).devices[0];
  reader.participate(initial.instance, false);
  const disabled = reader.sample([pad], config, 1).devices[0];
  draft.change(disabled, true, (instance, enabled) =>
    reader.participate(instance, enabled),
  );
  draft.cancel(reader.sample([pad], config, 1).devices, (instance, enabled) =>
    reader.participate(instance, enabled),
  );
  expect(reader.sample([pad], config, 1).devices[0].enabled).toBe(false);
  reader.sample([], config, 1);
  const reconnected = reader.sample([pad], config, 1).devices;
  draft.cancel(reconnected, (instance, enabled) =>
    reader.participate(instance, enabled),
  );
  expect(reader.sample([pad], config, 1).devices[0].enabled).toBe(true);
});
