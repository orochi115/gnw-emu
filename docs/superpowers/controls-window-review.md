# Independent controls window reviews

Scope: uncommitted native settings-window changes against baf3bcd.

First independent review found lost transient participation on Save for identical-fingerprint controllers: settings and game used separate readers. Resolved with main-owned committed runtime snapshots, per-window reader handoff by connection index plus fingerprint, and native Save/reopen Gamepad API regression.

Follow-up independent review reproduced two handoff edge cases: clearing all imported choices after one pad appears, and saving an empty visible-device list before Chromium exposes pads. Resolved by retaining each unseen imported choice separately and exporting both known instances and unseen selections. Import applies synchronously to existing instances, preventing duplicate snapshots on immediate Save. Reader unit tests cover initial empty scan, sequential exposure, immediate export, and disconnect cleanup.

Root verification also fixed collision checkbox precedence when a fingerprint already has saved preferences, and prevented the renderer document title overriding each native settings title.

Reviews used source inspection and targeted type/unit checks. Native Electron/QEMU and package evidence is recorded in docs/desktop/validation.md. No physical controllers were connected.
