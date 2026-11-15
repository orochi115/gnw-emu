# Implementation plan

Execute inline under the user's explicit master-first instruction; reviewers are advisory and do not replace runtime acceptance.

- [ ] Reproduce clock movement outside all edges in unit tests; implement shared clamp and apply at drag/native move/resize/scale/restore boundaries; verify negative origins/multi-monitor, unchanged size and normal behavior.
- [ ] Add actual Windows Unicode native session/save/load/restart regression; run before native changes and record failing diagnostic.
- [ ] Fix confirmed Windows encoding boundaries, commit native source, update master gitlink. Sync exact commits to Windows, build into a fresh native directory with provenance, repeat native acceptance.
- [ ] Verify master typecheck/unit/build and interactive Windows screen limits/clock behavior; commit master.
- [ ] Merge into special/windows-stock-dual, update portable README and Chinese relocation acceptance, package in a new output directory with rebuilt native.
- [ ] Verify extracted Zelda and Mario including Chinese application/UserData paths, saves/restart/clock limits, restrictions, relocation and unchanged firmware.
- [ ] Copy ZIP to local new output directory, validate CRC/SHA256/firmware hashes, record acceptance, sync source/docs and clean temporary tasks.
