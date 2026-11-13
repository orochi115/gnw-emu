# Windows Native Port Implementation Plan

**Goal:** Build and use gnw-emu and its development tools natively on the authorized Windows host.
**Architecture:** UCRT64 gwemu, native Windows Node/Electron, ARM GNU firmware tools; platform-specific secure session endpoints with unchanged lease semantics.

1. Bootstrap pinned MSYS2, install UCRT64 dependencies and ARM toolchain in the requested workspace; clone exact local parent revision and pinned submodules.
2. Run current gwemu build to reproduce Windows failures; minimally fix host-specific paths/C code. Record actual .exe build manifest and dependency DLLs.
3. Add PowerShell bootstrap/build/package entry points and Windows documentation. Verify compiler, native capabilities and staged provenance on actual host.
4. Delegate current-session transport adaptation to a single implementer using subagent-driven-development: Windows private discovery, RPC/proxy endpoints, native GDB mapping, Python client/CLI interoperability. Preserve POSIX implementation and session ownership semantics. Write behavioral tests before implementation, run direct regressions and Windows integration. Implementer owns desktop manager endpoints/listener/protocol/controller/command/index and manager Python session transport files; root owns scripts, packaging and native source.
5. Run desktop typecheck/build, relevant tests, actual Electron ROM/frame/input/save-state and manager workflows with isolated data. Build directory package and validate native dependency loading independently of toolchain PATH.
6. Review against requirements and code quality, fix demonstrated blockers, document evidence and any remaining limits. No publishing or physical device access.
