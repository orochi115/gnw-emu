# Retro-Go consolidation implementation plan

> **For agentic workers:** Use subagent-driven-development for independent asset/build tooling, then root integration and verification. Do not touch user source ROMs, existing firmware/backups/profiles, or .superpowers.

**Goal:** Consolidate both storage modes on the existing user retro-go-sd fork; migrate the full local library losslessly; retire the legacy source gitlink only after replacement firmware acceptance.

**Architecture:** An ignored local library contains original files and a hash manifest plus normalized media trees. An isolated build entry consumes an explicit ROM selection for SD_CARD=0, stages fixed release cores, constructs erased flash images with bounds checks, and writes a gnw.json profile. SD launchers consume the same normalized full library. Original data and legacy firmware continue to exist.

**Tech Stack:** Python, shell, GNU Make, Arm GCC, FrogFS/LittleFS, gwemu QMP, pytest.

**Approved:** User selected recommended migration in async answer, 2026-11-13. Assessment/design: docs/research/2026-11-13-retrogo-consolidation.md.

### Task 1: Local library migration

Files: scripts/migrate_retrogo_assets.py; tests/test_retrogo_assets.py.

- [ ] Add meaningful tests for same-stem .gb/.gbc preservation, checksum manifest, placeholder/cache filtering, cheats/covers routing, refusal to overwrite existing conflicting files.
- [ ] Run .venv/bin/python -m pytest tests/test_retrogo_assets.py (expected missing implementation failure).
- [ ] Implement source-preserving migration CLI: --source --output. Preserve every original regular file in originals/, normalize ROM/cover/cheat/BIOS paths in media/. SHA256 manifest maps each source file to all destinations. No symlink-following or silent overwrites. GB colliding filenames gain extension in stem.
- [ ] Run tests and real full library migration to ignored local/retrogo-assets. Verify all source hashes and all mapped destinations.

### Task 2: Flash-only build/package entry

Files: scripts/build_retrogo_flash.py; tests/test_retrogo_flash.py; profiles/retrogo-flash-selection.json.

- [ ] Tests first: explicit selection, missing files failure, safe non-overlapping OFW/FrogFS/LittleFS assembly, overflow fails without writing output, erased FF gaps, profile paths.
- [ ] Run focused pytest (expected missing implementation failure).
- [ ] Implement isolated source copy without .git/build/release/sd_content, preserving initialized nested source contents and downloaded Drivers. Use the new local media tree and explicit selected normalized relative ROM paths. Stage selected covers, cheats, fonts and fixed release cores and BIOS.
- [ ] Use SD_CARD=0 all littlefs_image; include cheats in FrogFS; output raw bank firmware, whole-chip extflash image and profile. Support standalone Bank1 and Bank2 with explicitly supplied OFW bank1/external image and offset, preserve OFW prefix. Validate FrogFS size against writable partition start and chip capacity.
- [ ] Avoid upstream gwemu_release: it zero-fills and assumes fixed64MiB; use checked own packaging.
- [ ] Verify unit tests and execute selected representative eight-platform builds using GCC10.3.1 and .venv-rgsd, current64MiB.

### Task 3: Fork patch migration and integration

Files: existing user's externals/retro-go-sd/Makefile.common; scripts/run_sd.sh, scripts/run_sd_update.sh; docs/sdcard.md; docs/lle/README.md; .gitmodules.

- [ ] Preserve existing user's fork linker fix. Add configurable SDK mirror prefix/progress option covering SDK/CMSIS/HAL; do not modify third-party nested sources.
- [ ] Compare legacy PCE scaling patch with pinned pce core; port only when necessary and fork its repository first if code must change.
- [ ] Change current SD launcher's default to unified local media tree; use copy helper that excludes hidden placeholders, while preserving user ROMS override.
- [ ] Preserve legacy firmware recovery files and record hashes/source pins. Do not auto archive remote repositories.

### Task 4: Runtime acceptance and retirement

- [ ] No-SD new flash launcher and eight representative game launches, screenshot evidence; new save/load/persistence exercise; Bank2 OFW handoff; current SD firmware/menu direct regression.
- [ ] Verify original asset hash manifest and legacy snapshot checksums; focused script tests and syntax checks.
- [ ] Review concrete changes for data loss/incorrect storage layout/scope failures; correct substantiated issues.
- [ ] Once acceptance passes, remove old gitlink and .gitmodules section while preserving physical historical checkout; update active docs and source references.
- [ ] Publish changed user-fork source branch if parent gitlink needs durable remote availability, verify exact remote SHA. Parent changes only local commit, no parent push (existing workspace convention).
- [ ] Write final evidence/report and mark plan progress accurately.
