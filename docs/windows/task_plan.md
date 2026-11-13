# Windows native port (2026-11-13)
User authorizes implementation and toolchain installation on sakura@172.16.40.35 under D:\LLM_Work\Game_Watch.
- [x] Inspect repository and Windows host.
- [x] Install isolated MSYS2 UCRT64 and ARM GNU toolchains; transfer pinned sources.
- [ ] Build native gwemu; resolve demonstrated Windows compilation failures.
- [x] Add repeatable Windows build/package/launch scripts and DLL staging.
- [x] Port current-session management transports with Windows access controls.
- [ ] Validate desktop build, native execution, ROM loading, state save/load, manager and package.
- [ ] Document exact commands, results and limitations.
Preserve existing source ROMs, UserData, remote projects and .superpowers. No physical-device writes. No repository publishing requested.
