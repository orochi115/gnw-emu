# Recent ROMs Implementation Plan

**Goal:** Add recent ROM loading, remove duplicate scale action and safely integrate.

**Architecture:** Main-process history with serialized settings patches; native
menu callbacks reuse the existing SessionController loading lifecycle.

**Tech Stack:** Electron, TypeScript, Zod, Vitest, Playwright.

- [x] Add failing menu/history tests; run `npm test -- tests/unit/menu.test.ts tests/unit/recent-roms.test.ts`.
- [x] Add `src/core/recent-roms.ts`, settings field and localized File submenu;
  record only successful loads in `src/main/index.ts`. Clear commits before publish.
- [x] Remove Restore 1:1 from menu, IPC, locale, automation and tests; retain scale 1.
- [x] Add real UI history/restart/failure/clear coverage and update desktop docs.
- [x] Run typecheck, unit, build, E2E, package and review implementation.
- [ ] Fetch, commit/push feature, merge/push master; preserve UserData/out/dependencies,
  rebuild QEMU and desktop in primary checkout, remove worktree.
- [ ] Run four launcher smoke tests from primary checkout and verify Git/paths.
