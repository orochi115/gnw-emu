# gnwmanager 完整备份实施计划

> 使用 subagent-driven-development 执行，独立规范/质量审查；用户已授权持续推进原三阶段路线，跳过实机/实体手柄验证。

**Goal:** 在manager实现完整backup/verify/restore/fetch，兼容旧归档并以真实QEMU/manager回归验证后退出旧backup依赖。
**Architecture:** archive纯校验与backend/GnW设备操作分离；CLI通过backend_factory延迟连接（损坏归档不连接）；GDB raw连接不resume。原始extras/banks先直接backend双读，无reset/上传/mailbox写；外Flash之后用真实manager。TOCTOU：恢复调用flash前使用已校验的实际payload bytes，并对使用中改变拒绝或固定已验证副本；fetch先manifest后固定允许文件，不使用远端shell通配符。
**Tech Stack:** Python3.13 manager、pytest、Cyclopts、TCG/GDB/真实manager firmware、loopbackHTTP；无实机。

规范 docs/superpowers/specs/2026-11-13-gnwmanager-full-backup-design.md，spec review APPROVED out/gwemu-completion/backup-spec-review.txt。父起点c992374，native ae00b68，manager起点7a82d65。保留原十镜像/产品数据/旁manager/16603/.superpowers；父不push。

## Task 1: manager完整backup实现与单元证明
Files: externals/gnwmanager/gnwmanager/full_backup.py, cli/_backup.py, cli/main.py, cli/__init__.py, ocdbackend/gdb_backend.py, tests/test_full_backup.py, tests/test_gdb_backend.py。
- [x] 先测试RED：旧/new归档正确/损坏/空/未知/路径/符号链接/长度/容量；partial coverage与regions严格验证；fixtures使用准确bank256KiB/extras256/65536/128。
- [x] 原始capture次序spy：直接backend双读，内部/extras读取前不resume/reset/upload/write；GDBBackend resume_on_connect=False wire test不发送c，原默认True不变；short读/双读不一致无完成manifest且诊断保留。
- [x] 实现独立纯archive verifier/hash（流式）与capture，先银行/extras双读，再startmanager外Flash全容量双读，atomic完成manifest、新输出不覆盖。
- [x] restore先完整verify/选择/confirm，再factoryopen与真实capacity/RDP前检；仅Flash选定bank1/bank2/ext写入，extras不写。payload就是已校验bytes/固定副本；每writtenregion完整SHA读回。错误容量/校验/读回与partial状态报错，不损archive；无自动lock/unlock。fullcapture后execution状态明确默认暂停/--resume显式。
- [x] fetchHTTP(S)真实协议实现与SCP HOST:REMOTE_DIR argv兼容；manifest优先固定六文件，无本地shell/远端通配符；目的地新staging→verify→rename，失败不暴露完成dest。有限长度/网络超时/manifest大小，远端path安全；HTTP实际loopback成功/损坏、SCP参数与失败路径测试。
- [x] CLI四命令thin、offlineverify/fetch不创建backend，restore损坏在factory调用前拒绝；manager既有tests全套通过。实现者只编辑这些manager文件，不提交/push。

## Task 2: actual模拟器集成与review
Files: tests/test_gwemu_backup.py, harness/gnwmanager_worker.py(必要时另独立worker), docs/research/2026-11-13-gnwmanager-full-backup.md。
- [x] fresh synthetic/copied镜像，完整两bank与外Flash真实TCG/GDB、固定manager firmware build；rawcapture保留ITCM/RAM/RTC，无resetPC变化/上传前串行证据。每个worker有限deadline，仅ownedprocesses。
- [x] 完整backup→改变副本→selectrestore→独立整份镜像/读回比较；partial/旧manifest兼容、损坏zero-write、capacity/readback mismatch失败；真实loopbackHTTP fetch successful与损坏拒绝。
- [x] manager规范review、质量review和安全audit原十hash/来源/旁manager/16603；通过后manager本地commit，按既有授权公开发布orochi115/gnwmanager:gnw-emu并remoteSHA核对；父gitlink/tests/docs本地commit。

## Task 3: 全路线后续收尾
- [ ] 在当前会话接口和完整管理命令/唯一gwemu产品回归通过之后，才移除backup旧依赖并留下旧fork最终tag/可复现说明、归档授权远程。不要在Task1/2提前删除旧backup。
- [ ] 完整goal继续active，阶段三会话协调/产品solekernel/旧session保护/退出oldQEMU另具体设计实施。

单测从externals/gnwmanager运行：../../build/gnwmanager-python/bin/python -m pytest -q tests/test_full_backup.py tests/test_gdb_backend.py；完整manager tests全部（缺失外部工具明示）；实际父tests使用固定GWEMU_BINARY与GNWMANAGER_PYTHON并验证zero skip。任何失败先根因调查，不缩断言或制造stub RED。
