# Desktop clock resilience implementation plan

Master first. Execute independent components with precisely scoped agents; root owns integration and final acceptance. No authorization gate is needed for routine choices in the user's explicit implementation/build request.

- [ ] Record baseline typecheck/unit results and preserve existing unrelated edits.
- [ ] Window component: add no-focus Windows topmost repair/watchdog, timer cleanup/minimize handling, compact three-button toolbar; reproduce and verify with window-mode regressions.
- [ ] Native ownership/diagnostics: encapsulate owned spawn and Windows Job Object/POSIX guardian; use in sessions and probes; capture native probe failures; add periodic bounded memory diagnostics and unit/integration checks.
- [ ] Recovery component: bounded cancellable restart policy, old-child cleanup, recoverable error classification, structured attempt/result/exhaustion logs and tests.
- [ ] USB/main integration: clock USB invariant at startup/restore/snapshot/device controls; preserve mode/minimize; wire recovery and diagnostics; unit/typecheck/build, actual macOS/Windows tests.
- [ ] Review implementation for scope and code quality, resolve findings, commit only task files on master.
- [ ] Rebuild special worktree, merge master, run both branch checks; package in new release/output directory using clean pinned native.
- [ ] Final ZIP real Windows acceptance, fault injection/owned-child cleanup, USB, shell occlusion, toolbar, Chinese relocation and saves; copy ZIP locally and validate.
- [ ] Record acceptance, sync final master/special source, remove temporary tasks and only the worktrees created for this task.
