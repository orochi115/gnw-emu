# gwemu 唯一内核与历史依赖退役实施计划

> **用户最新执行规则（覆盖本计划和技能中的旧审查循环，2026-11-13）：** 按原定目标验收并复用有效证据，不新增完成门槛。只有具备具体触发、代码证据、实际严重后果、且违反既定需求的 Critical/Important 问题可以阻塞。其余意见仅记录最终报告，不修改、不加测试、不阻塞。修复后只复查原问题及直接回归，不重复开放式全量审查求 APPROVED。重大范围变更交用户决策；实机/实体手柄豁免及既有发布/保护授权不变。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development。逐任务按既定目标实现和验证，问题复核遵守用户最新规则；user已授权完成原路线，父提交仅本地。

**Goal:** 将所有产品入口切成唯一gwemu，保存旧session数据并退出两个旧fork维护。
**Architecture:** 导入使用旧UIlease+实际native文件锁，复制savedFlash/SD到新namespace，保留全部旧文件。canonical headless gwemu提供guest初始化前的小型lock guard内的原子不覆盖目录publication，不依赖系统Python或Node addon；产品/CLI/build/package引用同一产物及manifest。
**Tech Stack:** QEMU C/qemu_lock_fd、TypeScript/Node fs/childprocess/Vitest、Pythonpytest、Electron/Playwright、shell/Git/GitHub。

设计`docs/superpowers/specs/2026-11-13-gwemu-product-retirement-design.md`，审查`out/gwemu-completion/product-spec-review.txt`APPROVED。backup/session完整实现审查和实际命令验收完成后执行，不能仅凭此plan退休对照。原十hash、实际UserData、旁manager、16603、.superpowers不改；物理验证豁免并如实报告。

## 精确导入与helper约定

native新增`--gnw-session-guard ABS_LOCKFILE`：仅3个argv，headlessmain在qemu_init前分流，开O_RDWR|O_CREAT|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK0600（避免FIFO open在fstat之前阻塞）并fstat当前UID/普通文件，`qemu_lock_fd(fd,0,1,true)`同旧native；stdout单行`{"protocol":1,"ready":true}`，fflush后阻塞读stdin到EOF，未配置publication时任何额外非空命令拒绝，closefd正常退出；配置publication时只接受下述单次COMMIT。占用/路径类型/owner失败stderr简短原因exit非0。整个guard只使用一个lockfd，不在该process再次open/close同inode；signal/parentstop可回收。UI从ready到publication结束监控child.exit，失锁任何await后失败；startup3秒、shutdown3秒、copy/hash总10分钟，UIstop立即取消。没有CPU/设备/network初始化。

POSIX原子无覆盖publish不能只exists+rename，且必须由同一仍持source lock的guard process执行。guard支持`--gnw-session-guard ABS_LOCKFILE --publish ABS_STAGE ABS_DEST`（6argv、qemu_init前）；stage/dest同parent下非symlink目录，dest不存在。ready后只接受一条最多128字节精确`COMMIT\n`或stdin EOF；EOF/终止前未收到COMMIT不发布。COMMIT在持唯一lockfd期间检查stage/session.json为当前UID普通完成元数据，再调用macOS renamex_np(RENAME_EXCL)或Linux renameat2(RENAME_NOREPLACE)，unsupported明确失败，不fallback覆盖rename。成功回复`{"protocol":1,"committed":true}`并仍持锁到stdin EOF；失败回复有界error且exit非0，dest存在包括空目录失败并保留stage/dest。不能另外spawn不持锁的publisher。

提交/取消的线性化边界：Node在发送COMMIT之前同步将attempt置commitInFlight，先复核cancelled/owner/guardalive；commitInFlight之前cancel终止guard并禁止发COMMIT。发送之后cancel不能撤回原子提交，UIstop取消guest启动并有限等待helper ack/exit（最多3秒），不能说“取消保证未导入”；若ack丢失检查destination的本attempt migration.importId判断completecommitted或明确unknown。此时有效完成导入可保留，原legacy一直不删；绝不再启动guest。guard途中死亡则无法由另一进程publish。dest lease保持到helper reaped及提交结果确认，旧ownercleanup不释放新owner。测试迫出ready后死亡、COMMIT前取消、COMMIT后stop、rename后ack丢失及碰撞窗口。Windows无实际POSIX导入证明明确unsupported；canonical headless含guard能力，自带GUI自定义build无能力则导入拒绝。

导入顺序：当前load先占新gwemu destination UIlease→check existingvalidgwemu优先→不存在且legacy存在，占旧UIlease→nativeguard锁旧qemu.lock→验证旧sessionSchema（无model/hash，不要求不存在字段）与profile实际镜像尺寸→copy exactallowlist→全SHA→gwemuconfiguration/capability验证→写session/migration元数据→原子无覆盖guard.commit原子publish→确认committed/importId→释放guard/旧lease→启动新native。每await核loadattempt取消/owner/guardalive；任何错误不fallbackbaseline覆盖旧save。目标UIlease一直到新native退出，旧lease只到导入完成。

allowlist：必须`session.json,bank1.bin,flash.bin`；profile要求bank2/SD则相应`bank2.bin,sdcard.img`必须存在，不能schema默认掩盖缺文件；profile未声明时不擅自加载额外文件。旧RDP始终0不推断未知sidecar，不复制任何`.rdp/.unlock`旧格式、runs/state/socket/lease/qemu.lock。copy产生新inode；拒绝source非普通文件/symlink/与profilebaseline hardlink别名。容量支持延续gwemu本身limits。旧battery/USB/RTC/life/charge保留，batteryPresent默认true。

新gwemu sessionSchema增加optional migration：`{version:1,source:"legacy-session",importedAt:ISO8601,importId:UUID,files:{"bank1.bin":{bytes,sha256},"flash.bin":...optionalbanksd}}`，strict allowlist/size/hash验证，saveSession保持此metadata。显示一次明确notice：旧已保存Flash/SD已导入，旧即时存档保留但不可跨内核。gwemu slot不存在且旧同slot存在时read-onlylookup旧manifest，返回state.incompatible而非state.empty，不import旧VMstate。已有gwemu数据优先，不再看旧savedFlash，但旧slot解释仍有效。

## Task 1：native迁移锁与publication工具

Files：新`externals/gwemu/system/gnw-session-tools.c`、`include/system/gnw-session-tools.h`；改`system/main.c`、`system/meson.build`；父新`tests/test_gwemu_session_tools.py`，历史crosslegacy验收单独`tests/test_gwemu_legacy_import_lock.py`，后者Task6从维护collection退出保留历史证据；currentguardtests不依赖旧binary且无旧binary缺失skip。
- [ ] 先写实际subprocess测试：guard ready且无QMP/guest、两个guard互斥/EOF释放、symlink/FIFO/owner拒绝、malformedargv、signal/EOF bounded；旧native带syntheticnewqemu.lock启动时guard拒绝，guard持有时旧native拒绝（不使用16603本身）。
- [ ] 同guard publication测试存在emptydest/同parent检查/symlink拒绝、成功目录完整、确定性collision仍不覆盖。`GWEMU_BINARY=build/gwemu/qemu-system-arm .venv/bin/python -m pytest -q --tb=short tests/test_gwemu_session_tools.py`先RED，不能仅测试mockfcntl。
- [ ] 实现最小C工具，`GWEMU_BUILD_DIR=build/gwemu scripts/build_gwemu.sh`构建；先uncommittedbuild验证新helper行为并review，nativecleancommit后再recordmanifest使sourceDirty=false，记录实际新SHA。能力探测用guard规范help分支（不运行无ROMguest），旧buildbinary不覆盖。
- [ ] 完整相关native模型/供电/回滚/GDB+backup回归，独立规范/质量review后native本地commit并授权publishremoteSHA；工具不会改变既有机器行为。父tests/manifestdocs本地commit。

## Task 2：旧session原子导入与slot说明

Files：新`desktop/src/core/legacy-session-import.ts`、`native-session-tools.ts`；改`session-store.ts,schemas.ts,session-controller.ts,savestate-store.ts`，sharedusererror/locales/menu状态；新测试`desktop/tests/integration/legacy-session-import.test.ts`、新unit`session-store.test.ts`与`gwemu-savestate-store.test.ts`。
- [ ] RED：savedFlash/SD与baseline不同，导入复制savedbytes；existinggwemu优先、旧metadata保留/saveSession后migration仍在、缺bank/SD与坏capacity拒绝、symlink/hardlinkalias拒绝、oldslotread-only拒绝明确incompatible。
- [ ] 实actualguard旧native占用拒绝、两个新UI导入destination互斥、copymidway取消/guardexit禁止publish、fakehelperready后exit不能当仍持锁、publication碰撞不覆盖、旧所有文件全hash仍一致。
- [ ] 实现上述顺序，destinationlease先于prepare/import并贯穿；用nativeguard argv无shell，只ownedchildren，cancel有限清理不会释放newowner。configuration验证使用真实saved镜像；legacy保存bank1允许历史128KiB有效data，不强行要求256KiB。
- [ ] `cd desktop && npm run test -- tests/integration/legacy-session-import.test.ts tests/unit/session-store.test.ts tests/unit/gwemu-savestate-store.test.ts`；typecheck，独立两级review，本地commit。真实UserData不做任何导入试跑。

## Task 3：product默认与执行代码统一

Files：`desktop/src/core/paths.ts,kernel-backend.ts,session-controller.ts,session-store.ts,gwemu-command.ts`；新共用`qemu-arguments.ts`只escape；main/菜单/settings/locales/CLI使用处与相关tests。
- [ ] RED paths默认gwemu、packagedgwemu可用、UserData默认不再preview拒绝、legacyselection明确错误，`kernelEnvironment`继续过滤GNW/GWEMU环境；profile/model/SD/UID/source isolation保持。
- [ ] KernelKind仅gwemu执行；preflight/arguments/backendbuttons/audio/device/stop没有legacy分支；StateIdentity legacy仅历史detect不生成新legacy状态。修正load初始化等旧branch，无效realtime菜单/设置操作退出，旧storedboolean仍可parse保存且无运行快进语义。
- [ ] 删除维护中的qemu-command执行模块；gwemu escape移到无legacy依赖utility。现行tests从两kernel比较迁到solegwemu，旧纯legacy测试退出维护保留历史snapshot，不通过保留legacyRuntime代码让旧tests继续绿。
- [ ] `npm run typecheck && npm run test`实际全面单元，integration使用明确canonicalnative且requiredzero-skips；规范/质量review后localcommit。

## Task 4：build/launchers/CLI/staging

Files：`scripts/build.sh,build_gwemu.sh,launch_common.sh,run.sh,run_backup.sh,run_sd.sh`；`desktop/tools/cli.ts,stage-qemu.mjs,ui-cli.ts`、package/electronbuilderconfig；tests`test_launch_scripts.py`/desktoplaunchers/packaged。
- [ ] RED默认build只canonicalgwemu不写旧build、session-dir打印gwemunamespace、cli probe使用defaultgwemu与实际importguard；launcher明确参数override与freshprofile兼容，旧backupDir作为用户历史asset位置保留而非执行依赖。
- [ ] stage校验source cleanmanifest/revision/hash/capabilities；同一configure/toolchain/identity复制manifest到resources。relocation/sign之后产生stagingmanifest，包含sourceSHA/stagedSHA/libshashes；runtime identity取真正binaryhash。未验证自定义source拒绝，ROM/SD不打包。
- [ ] 从build:cli删compare-kernels工具执行，历史工具移出维护index后保留本地file/ignore；linux/windows打包代码明确现有platformlimits，不宣称本机未测系统通过。
- [ ] `npm run build && npm run package:dir`，目录包isolatedsmoke；先在sandbox运行，GUI权限实际失败再工具请求escalation。tests确认不覆盖原build/qemu-system-arm/16603仍活。review/localcommit。

## Task 5：solekernel完整软件冻结验收

- [ ] 显式canonicalnative的供电/RTC/UID/input/frame/audio/CoreAudio/savestatefullrollback/SD两接线/manager完整commands+sessionlease+backup4actual回归。只重复受新native或product入口影响的验收，不任意扩充无关测试。实际OFW Mario/Zelda、flashRetroGo与SD两接线各copiedprofile。
- [ ] 真实Electron default无需--kernel：无ROM0native、启动各profile显示/输入/mute/power、warm/coldreset、managerlist/acquire/CLI操作后回应用、slotidentity、换ROM/close/reopenpersist、ownedcleanup。新增migration实际fixturecopy有savedchanges且activeoldchild refusal。
- [ ] 实际directorypackageisolatedsmoke验证相同能力与privateRPC，stagedbinaryhash/manifestmatches。不运行实际用户目录。软件gamepad按既有测试，physicalpad/hardware仅标waived。
- [ ] 原十hash、旁managerclean、原16603活、native/managerclean来源与已授权remoteSHA验证；全要求表记录passed/waived/remaining和验证命令/数量/限制。finalaggregate规范/质量review必须APPROVED后才Task6。

## Task 6：最终历史tag与退役

Files：`.gitmodules,.gitignore,README.md`、新`docs/research/2026-11-13-gwemu-migration-history.md`；index旧`externals/qemu,externals/game-and-watch-backup,qemu-gnw,scripts/qemu-savestate-hook.py`及旧专用tests/harness/tools。
- [ ] 读refs与remotestatus确认旧QEMU `bf6c2d6...`、backup `c4c807c...`和parent历史完整snapshot可复现；parentfinallegacytag仅本地，docs明确未发布父tag、提供本地checkoutref及公开parent可用历史ref（存在才写，不猜）。旧QEMU symlinktarget必须在history命令完整恢复。
- [ ] 对旧两个fork创建无覆盖的最终tag（名称如gnw-emu-legacy-final-2026-11-13，先check是否exist+target一致）；push仅旧forktag沿用退休授权，读remote exactSHA。
- [ ] `.gitmodules`移除两条、git index `git rm --cached`保留本机historicalworktree/build；移除维护中的oldmachine/hook/tests/comparetools同样保留本地ignore。不deinit/rm-rf。保留userbackup位置/文件；当前构建与测试不得需要oldsource。`harness/gnw.py`中被gwemutests需要的sourceassetpaths移到中立helper，删除旧runtime依赖；conftest不再以旧binary存在与否skipgwemu。
- [ ] README current流程重写：solegwemu build/profile/load/sessionmigration/manager auto/offlinebackup/debug/power、privateendpoints/oldslotcompatibility和豁免实机范围；历史refs单独historydocument，不把历史研究报告当维护依赖删掉。
- [ ] read-only审核当前maintenancefiles查`externals/qemu,build/qemu-system-arm,qemu-gnw,gnw_full_backup.py,compare-kernels`无执行引用；允许historyreports和旧dataassetpath说明。新checkout按维护submodules实际build/tests不会依赖旧worktree。
- [ ] 再相关build/unit/package/manager+backup最小freeze及10源hash/16603/ownedcleanup；两个forkGitHub archive后核archived=true；native/manager仍unarchived。任何archive失败留明确未完成项。
- [ ] 父finallocalcommit保留gitlinks exactremoteSHA；不pushparent。原始spec逐条finalreport完整passed/waived，所有requiredwork无remaining后才`update_goal complete`。不得以本task接近预算或某批通过关闭全部goal。
