# Clock context controls

USB audio loss was confirmed by the user to affect browsers too; reconnecting the
USB device restored both applications. Logs map CoreAudio -536870186 to I/O
Timeout. No audio backend replacement or automatic OS service restart is needed.

Clock right-click offers normal mode, dock submenu (four corners and free
floating), frame checkbox, mute checkbox, pixel scales and quit. Docking preserves
LCD scale and chooses the current display workArea with a 12 logical pixel inset.
Scale/frame changes keep the selected corner; manual dragging clears docking.
Persist clockDock alongside clockBounds, and retain it when switching modes.
Missing displays use existing placement recovery. Oversized windows keep top/left
controls accessible instead of changing pixel size.

Mute reuses settings.audio (enabled means !mute). QEMU gets a new runtime
machine audio-muted boolean propagated to its DMA host voice through the portable
QEMU mixer volume API. The desktop always initializes playback support, including
when starting muted; muting never disables guest DMA, restarts the game or changes
RTC. On disk failure revert the runtime mute, preserve the committed setting and
report an error. Backend lifetime remains unchanged.

Build the clock context menu through a reusable main-process template. ui.inspect
exposes contextMenus when clock mode is active. ui.contextMenu invokes that exact
native handler using allowlisted IDs, shares operation observation and guards;
normal native View also has a mute checkbox. Read diagnostics for host preference
and runtime audio-muted. Emit structured dock/mute events and document controls.

Verify all corners and negative display origins, drag cancellation, frame/scale
retention, restart persistence, real context menu callbacks, live QMP mute/unmute
and portable WAV samples silence/resumption. Rebuild QEMU before dependent tests.
