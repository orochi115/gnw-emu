# Savestates Implementation Plan

> Use test-driven-development and requesting-code-review; implementation has been authorized by the user and continues in this session.

**Goal:** Reliable no-SD state slots including all flash, with desktop feedback.
**Architecture:** QOM save-state/load-state call QEMU VMState stream functions synchronously while paused. Device state and flash use existing migration framework. Desktop owns serialized operations, transactional slot manifests and temporary rollback point. Existing renderer toast and input/menu plumbing expose actions.
**Tech Stack:** QEMU 11.1.3 C, Electron/React/TypeScript, pytest/Vitest/Playwright.

## File ownership and steps

### 1. Machine + flash, root
- [x] Add `tests/test_savestate.py`: missing API fails, repeated same/cross-process replay checks full DTCM/frame/MMIO/flash, unsupported SD/size, corrupt load recovery.
- [x] Add VMState in `gnw.c`, `gnw_flash.c`, `gnw_ospi.c`; add synchronous file API using QIOChannel and savevm/loadvm with pause and error discipline, matching QEMU 11.1.3 migration cleanup requirements.
- [x] Preserve host paths/endpoints; omit rebuilt XIP from RAM stream, rebuild and invalidate at post-load; overlay writes restore session.
- [x] Build via `scripts/build.sh`, targeted `.venv/bin/pytest tests/test_savestate.py` then native suite.

### 2. Timed/graphics/audio devices
- [x] Add VMState for `gnw_dma.c`, `gnw_ltdc.c`, `gnw_timer.c`, shared stream helpers in `gnw.h` only if required. Guest buffers/timing saved; host audio queued buffers cleared and rate/backend reinitialized on restore.
- [x] Exercise mid-transfer DMA/timer, LTDC phases, RTC; restored next-frame behavior must match without stale timers or clock discontinuity.

### 3. Remaining devices
- [x] Add VMState for `gnw_regs.c`, `gnw_gpio.c`, `gnw_dac.c`, `gnw_adc.c`, `gnw_spi.c`, `gnw_cryp.c`, `gnw_jpeg.c`. Serialize in-progress parser/FIFO/state, never pointers; bounded dynamic lengths validated before allocation.
- [x] Shared arrays/IRQ restoration use existing device update helpers; do not reset callback/link pointers. Empty SD model is not used in supported mode and carries no active transaction.

### 4. Desktop
- [x] Add meaningful failing unit/integration tests for atomic state slots and rollback, SD/size refusal, repeated action serialization.
- [x] Implement `core/savestate-store.ts`, integrate `SessionController`, contracts/preload/IPC/menu/control targets, locales.
- [x] Update existing toast to operation severity and expiry; menu checked slot and metadata, hotkey triggers through real control router. Default F5/F8; slot switching bindings as judged conflict-free.
- [x] Add real-window E2E menu/hotkey feedback and persisted state smoke. Run targeted Vitest, `npm run typecheck`, `npm run build`, targeted E2E and standard regression.

### 5. Review and completion
- [x] Review complete diff against spec, fix findings (self-review; agent transport returned unreadable tasks).
- [x] Update docs with flash rollback semantics, SD/64 MiB restrictions and hotkeys; record actual validation and latency/file size.
- [x] Finish working-tree implementation; no automatic merge/push.

Validation: native regression 56 passed; additional savestate suite 11 passed, including 64 MiB Retro-Go and realtime pacing. Desktop 117 tests, typecheck/build and 11 real-window E2E checks passed. See docs/desktop/savestates.md for boundaries and measured sizes.
