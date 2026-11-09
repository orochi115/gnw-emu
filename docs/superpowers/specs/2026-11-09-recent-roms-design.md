# Recent ROMs and menu cleanup

The requested File → Load Recent submenu stores up to ten successfully loaded
absolute `.gnw.json` paths in application settings, most recent first. Loading
again moves an entry to the front without duplicating it. CLI startup, the open
dialog and Save and Load all share the same success-only recording helper.
Cancellation and failure leave history unchanged. No ROM is automatically loaded
on startup. Clear Recent removes history without stopping the current game.

Items show the filename and parent directory so similarly named configurations
can be distinguished. Each native handler captures its path. The submenu and its
children follow the File menu's modal, clock, shutdown and lifecycle guards.
Missing files report the existing localized load error; entries stay available
because users may reconnect storage. History write failure is logged and shown
without turning a successful emulator start into a failed start.

The settings writer serializes narrow patches, preserving display preferences.
History uses fixed automation IDs `file.recent.0` through `file.recent.9` and
`file.recent.clear`; inspection exposes actual menu labels and enabled states.
Remove the redundant Restore 1:1 menu, IPC and automation action. Pixel Scale →
1× remains available in View and the clock context menu.

Verify ordering, bounds, deduplication, clear, persistence, unrelated settings,
real UI loading and failed loads. Integrate via fast-forward if possible, preserve
ignored runtime data and generated ROMs, rebuild the primary checkout, and run
all four workspace launch scripts after worktree removal. Never force-push.
