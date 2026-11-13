# Windows port review

2026-11-13, read-only review; root owns fixes and actual Windows execution.

## Must fix

1. P1 — `scripts/windows/bootstrap.ps1:52` initializes manager, retro-go-sd and patch but omits `externals/gwemu`. A normal nonrecursive clone followed by the documented bootstrap/build fails `scripts/build_gwemu.sh` with missing configure. Include gwemu in submodule initialization, including its recursive dependencies.
2. P1 — MSYS manager firmware build inherits `OS=Windows_NT`, selecting CMD `copy` while commands run under Bash. Override OS for this make invocation. Detailed reproduction in `review-firmware-tools.md`.
3. P1 — Flash `.xip` mapped artifact paths include native Windows drive colon; Make splits at first colon and corrupts the path. Use trial-relative POSIX paths in MAPPED_BINS. Detailed reproduction in `review-firmware-tools.md`.

## Verification requirements

- Packaging validates `git ls-tree HEAD externals/gwemu` against native checkout; root must pin native commit in parent before package, likewise manager commit for reproducible checkout. This is existing intended provenance, not a defect.
- Current Windows Vitest exclusion of POSIX shebang/socket fixtures is appropriate only with actual replacement coverage: native session lifecycle, manager leased GDB, Electron ROM/frame/input/state and packaged process on Windows.
- Windows ACL handling, TCP prefix auth, auth deadline, per-lease forwarding, Python discovery/debug backend, native `.exe` provenance, runtime DLL closure were inspected. No additional release-blocking defect found in these paths from static review.

Local checks fresh: `npm run typecheck` exit 0 and `git diff --check` exit 0. No Windows runtime claims from this reviewer.

## Final runtime-fix review (2026-11-13, after native commit 9170bdd)

Read-only re-review requested via manager-coordination.md. No new release-blocking defect found in the concrete fixes inspected.

- Socket close: explicitly restoring the `HANDLE_FLAG_PROTECT_FROM_CLOSE` mask with the original protected-bit value correctly clears temporary protection when original flags are zero. The subsequent `qemu_close_wrap` call still invokes `closesocket` on the captured handle. Unrelated inheritance flags remain unchanged. This addresses the demonstrated failure to deliver EOF after the authentication deadline.
- Flash durability: allowing `FILE_SHARE_WRITE` in the original read/write mapping permits `sync_flash` to reopen the same pathname with `O_RDWR` after `FlushViewOfFile`, then flush its file handle. Board initialization still acquires the exclusive `LockFileEx` session lock before padding/mapping flash. The sharing change does not alter that lock or replace the mapped file.
- DLL collector: streamed `objdump` output avoids the previous full-output buffer limit; transitive imports are visited once, native fallback DLLs are discovered under build/subprojects, missing imports fail explicitly, and MSYS runtime dependencies remain rejected. No implementation edits made by reviewer.
- All three initial P1 script findings are now addressed in the inspected source: bootstrap includes externals/gwemu, manager make passes OS=MSYS with a relative BUILD_DIR, and MAPPED_BINS uses trial-relative POSIX paths. Firmware PATH also converts the ARM bin path to MSYS form.

Fresh reviewer checks: TypeScript typecheck exit 0; git diff --check exit 0; local `build/gnwmanager-python/bin/python -m pytest tests/test_retrogo_flash.py tests/test_gwemu_gdb_auth.py -q` reports **13 passed**. These are local regression checks, not independent Windows runtime evidence. Root reports actual Windows auth/state/Electron checks passing and is building the final clean native package; final packaged executable and Zelda workflow verification remain root-owned completion checks.
