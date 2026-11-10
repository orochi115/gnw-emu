# Clock context controls implementation

Goal: four-corner clock docking, frame and live persistent mute in native context menu.
Architecture: WindowMode owns geometry, main owns preferences/menu, QMP controls
only QEMU host mixer muting. Electron/TypeScript, QEMU C, Vitest/Pytest/Playwright.

- [x] Write failing docking/menu and mute persistence tests.
- [x] Add shared dock geometry, clockDock settings/state and WindowMode pinning.
- [x] Add QEMU audio-muted property + DMA mixer muting; test real PCM with WAV.
- [x] Add transactional audio preference and SessionController live mute.
- [x] Extract context template, add locale, automation context inspection/actions.
- [x] Verify real context callbacks retain runtime/scale and persistent settings;
  run full typecheck/unit/build/UI suites, rebuild directory app and smoke.
- [x] Update documentation, review changes and resolve actionable findings.
