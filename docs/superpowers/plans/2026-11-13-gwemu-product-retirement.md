# gwemu 唯一内核与历史依赖退役实施计划

> **用户最新执行规则（覆盖本计划和技能中的旧审查循环，2026-11-13）：** 按原定目标验收并复用有效证据，不新增完成门槛。只有具备具体触发、代码证据、实际严重后果、且违反既定需求的 Critical/Important 问题可以阻塞。其余意见仅记录最终报告，不修改、不加测试、不阻塞。修复后只复查原问题及直接回归，不重复开放式全量审查求 APPROVED。重大范围变更交用户决策；实机/实体手柄豁免及既有发布/保护授权不变。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development。逐任务按既定目标实现和验证，问题复核遵守用户最新规则；user已授权完成原路线，父提交仅本地。

**Goal:** 将所有产品入口切成唯一gwemu，不导入已生成旧 UserData，保留旧文件，并退出两个旧fork维护。
**Architecture:** gwemu session 在独立 namespace 从 profile baseline 创建并正常持久化，不扫描/导入 legacy UserData；产品/CLI/build/package 引用同一 canonical gwemu 产物及 manifest。旧备份归档格式支持保留。
**Tech Stack:** QEMU C/qemu_lock_fd、TypeScript/Node fs/childprocess/Vitest、Pythonpytest、Electron/Playwright、shell/Git/GitHub。

设计`docs/superpowers/specs/2026-11-13-gwemu-product-retirement-design.md`，审查`out/gwemu-completion/product-spec-review.txt`APPROVED。backup/session完整实现审查和实际命令验收完成后执行，不能仅凭此plan退休对照。原十hash、实际UserData、旁manager、16603、.superpowers不改；物理验证豁免并如实报告。

## 范围修订与已取消任务（2026-11-13）

用户明确已生成 UserData 无需兼容。原 Task 1（native 导入锁/原子 publication 工具）和 Task 2（legacy session 导入、migration 元数据/通知、旧 slot 查找）全部取消；没有已实施代码需要回退。相关准备 handoff 不再授权执行。不为取消任务构建新 native 或新增其测试。

正常 gwemu session 从 profile baseline 创建，既有 gwemu session/slot 正常保存和加载，源文件保护保留。旧 UserData/session/slots 留原处，不导入、不改写、不删除。`.gnw.json`、原 ROM/SD 输入和 manager 旧备份归档格式支持保持既定范围。

后续保留 Task 3–6 编号以对照原计划。

## Task 3：product默认与执行代码统一

Files：`desktop/src/core/paths.ts,kernel-backend.ts,session-controller.ts,session-store.ts,gwemu-command.ts`；新共用`qemu-arguments.ts`只escape；main/菜单/settings/locales/CLI使用处与相关tests。
- [ ] RED paths默认gwemu、packagedgwemu可用、UserData默认不再preview拒绝、legacyselection明确错误，`kernelEnvironment`继续过滤GNW/GWEMU环境；profile/model/SD/UID/source isolation保持。
- [ ] KernelKind仅gwemu执行；preflight/arguments/backendbuttons/audio/device/stop没有legacy分支；新状态只生成 gwemu identity，保留现有的内核/build 不兼容校验，不新增旧目录查找。修正load初始化等旧branch，无效realtime菜单/设置操作退出，旧storedboolean仍可parse保存且无运行快进语义。
- [ ] 删除维护中的qemu-command执行模块；gwemu escape移到无legacy依赖utility。现行tests从两kernel比较迁到solegwemu，旧纯legacy测试退出维护保留历史snapshot，不通过保留legacyRuntime代码让旧tests继续绿。
- [ ] `npm run typecheck && npm run test`实际全面单元，integration使用明确canonicalnative且requiredzero-skips；规范/质量review后localcommit。

## Task 4：build/launchers/CLI/staging

Files：`scripts/build.sh,build_gwemu.sh,launch_common.sh,run.sh,run_backup.sh,run_sd.sh`；`desktop/tools/cli.ts,stage-qemu.mjs,ui-cli.ts`、package/electronbuilderconfig；tests`test_launch_scripts.py`/desktoplaunchers/packaged。
- [ ] RED默认build只canonicalgwemu不写旧build、session-dir打印gwemunamespace、cli probe使用defaultgwemu；launcher明确参数override与freshprofile兼容，旧backupDir作为用户历史asset位置保留而非执行依赖。
- [ ] stage校验source cleanmanifest/revision/hash/capabilities；同一configure/toolchain/identity复制manifest到resources。relocation/sign之后产生stagingmanifest，包含sourceSHA/stagedSHA/libshashes；runtime identity取真正binaryhash。未验证自定义source拒绝，ROM/SD不打包。
- [ ] 从build:cli删compare-kernels工具执行，历史工具移出维护index后保留本地file/ignore；linux/windows打包代码明确现有platformlimits，不宣称本机未测系统通过。
- [ ] `npm run build && npm run package:dir`，目录包isolatedsmoke；先在sandbox运行，GUI权限实际失败再工具请求escalation。tests确认不覆盖原build/qemu-system-arm/16603仍活。review/localcommit。

## Task 5：solekernel完整软件冻结验收

- [ ] 显式canonicalnative的供电/RTC/UID/input/frame/audio/CoreAudio/savestatefullrollback/SD两接线/manager完整commands+sessionlease+backup4actual回归。只重复受新native或product入口影响的验收，不任意扩充无关测试。实际OFW Mario/Zelda、flashRetroGo与SD两接线各copiedprofile。
- [ ] 真实Electron default无需--kernel：无ROM0native、启动各profile显示/输入/mute/power、warm/coldreset、managerlist/acquire/CLI操作后回应用、slotidentity、换ROM/close/reopenpersist、ownedcleanup。验证新 session 从 baseline 创建和后续 gwemu 写入持久化，不扫描或导入旧 session。
- [ ] 实际directorypackageisolatedsmoke验证相同能力与privateRPC，stagedbinaryhash/manifestmatches。不运行实际用户目录。软件gamepad按既有测试，physicalpad/hardware仅标waived。
- [ ] 原十hash、旁managerclean、原16603活、native/managerclean来源与已授权remoteSHA验证；全要求表记录passed/waived/remaining和验证命令/数量/限制。按用户最新有限审查规则核对原要求后才 Task6，不要求重复全量 APPROVED。

## Task 6：最终历史tag与退役

Files：`.gitmodules,.gitignore,README.md`、新`docs/research/2026-11-13-gwemu-migration-history.md`；index旧`externals/qemu,externals/game-and-watch-backup,qemu-gnw,scripts/qemu-savestate-hook.py`及旧专用tests/harness/tools。
- [ ] 读refs与remotestatus确认旧QEMU `bf6c2d6...`、backup `c4c807c...`和parent历史完整snapshot可复现；parentfinallegacytag仅本地，docs明确未发布父tag、提供本地checkoutref及公开parent可用历史ref（存在才写，不猜）。旧QEMU symlinktarget必须在history命令完整恢复。
- [ ] 对旧两个fork创建无覆盖的最终tag（名称如gnw-emu-legacy-final-2026-11-13，先check是否exist+target一致）；push仅旧forktag沿用退休授权，读remote exactSHA。
- [ ] `.gitmodules`移除两条、git index `git rm --cached`保留本机historicalworktree/build；移除维护中的oldmachine/hook/tests/comparetools同样保留本地ignore。不deinit/rm-rf。保留userbackup位置/文件；当前构建与测试不得需要oldsource。`harness/gnw.py`中被gwemutests需要的sourceassetpaths移到中立helper，删除旧runtime依赖；conftest不再以旧binary存在与否skipgwemu。
- [ ] README current流程重写：solegwemu build/profile/load/session持久化/manager auto/offlinebackup/debug/power、privateendpoints/新slot身份校验与旧数据不导入说明和豁免实机范围；历史refs单独historydocument，不把历史研究报告当维护依赖删掉。
- [ ] read-only审核当前maintenancefiles查`externals/qemu,build/qemu-system-arm,qemu-gnw,gnw_full_backup.py,compare-kernels`无执行引用；允许historyreports和旧dataassetpath说明。新checkout按维护submodules实际build/tests不会依赖旧worktree。
- [ ] 再相关build/unit/package/manager+backup最小freeze及10源hash/16603/ownedcleanup；两个forkGitHub archive后核archived=true；native/manager仍unarchived。任何archive失败留明确未完成项。
- [ ] 父finallocalcommit保留gitlinks exactremoteSHA；不pushparent。原始spec逐条finalreport完整passed/waived，所有requiredwork无remaining后才`update_goal complete`。不得以本task接近预算或某批通过关闭全部goal。
