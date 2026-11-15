# Implementation plan

Execute inline under the user's explicit master-first instruction; reviewers are advisory and do not replace runtime acceptance.

- [x] Reproduce clock movement outside all edges in unit tests; implement shared clamp and apply at drag/native move/resize/scale/restore boundaries; verify negative origins/multi-monitor, unchanged size and normal behavior.
- [x] Add actual Windows Unicode native session/save/load/restart regression; run before native changes and record failing diagnostic.
- [x] Fix confirmed Windows encoding boundaries, commit native source, update master gitlink. Sync exact commits to Windows, build into a fresh native directory with provenance, repeat native acceptance.
- [x] Verify master typecheck/unit/build and interactive Windows screen limits/clock behavior; commit master.
- [x] Merge into special/windows-stock-dual, update portable README and Chinese relocation acceptance, package in a new output directory with rebuilt native.
- [x] Verify extracted Zelda and Mario including Chinese application/UserData paths, saves/restart/clock limits, restrictions, relocation and unchanged firmware.
- [x] Copy ZIP to local new output directory and validate CRC/SHA256/firmware hashes; record acceptance.
- [ ] Sync final source/docs and clean temporary tasks.
