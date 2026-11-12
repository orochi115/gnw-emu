# gnwmanager 完整备份迁移验收记录

状态：实际模拟器、独立规范与最终质量审查均通过；manager已公开发布5c3629053996800264173328b5c48b49572e74eb，远程分支SHA核对一致。未退出旧backup依赖，不能据此宣称完整迁移完成。实机备份/恢复按用户要求豁免，没有实机通过声明。

设计与计划：`../superpowers/specs/2026-11-13-gnwmanager-full-backup-design.md`、`../superpowers/plans/2026-11-13-gnwmanager-full-backup.md`。

## 实际 core 路径

运行：

```sh
GWEMU_BINARY=build/gwemu-manager-ram/qemu-system-arm \
  .venv/bin/python -m pytest -q --tb=short tests/test_gwemu_manager_backup.py
```

2026-11-13首次核心运行4 passed，15.82秒；fetch修复后4 passed，16.79秒；质量修复及读回错误/实际串联CLI验收后6 passed，22.50秒；共享GnW缓存修复与四种真实连续manager命令验收后最终10 passed，35.31秒，均zero skips。worker使用`build/gnwmanager-python/bin/python`，真实TCG/GDB与manager firmware，父进程拥有native及有限180秒worker总截止。测试只使用新建合成镜像，均为不同inode的新文件。

固定来源：native `ae00b68951ab44b0dffb265e3f61340d735a68e5`；binary SHA256 `69750cd46454dab640d1e0d8c47c04b32ec703d09217a1730775887a99d8ad1a`。上传manager firmware 49440字节，SHA256 `bf2c67e6cf352d7e5e0586b13f608431e32c294b12908558e48f63863445d9e9`，原firmware构建来源`7a82d653f23b5e3b5802eb4ce1e5076f94aa379b`。本批manager Python代码正在修改，不能把firmware来源SHA等同于整个新host实现来源。

| 验收 | 实际检查 |
| --- | --- |
| 完整捕获 | 两个256KiB bank、1MiB外Flash、原始extras六文件；SHA与源合成镜像一致 |
| 原始现场 | capture前后PC/MSP/r0/xPSR、SRAM sentinel、ITCM、RTC备份区SHA一致；上传manager前backend write/reset/resume次数为0 |
| partial | skip-ext不上传manager，最终仍保留同一原始现场；CPU暂停，Flash源未变 |
| 选择恢复 | 全区域真实manager写成其他内容，仅restore bank2，bank1/ext保持改变后的内容 |
| 完整恢复与持久化 | 完整恢复三区域，native退出后整份文件SHA一致；重新打开native再次读取一致；archive自身文件SHA未变 |
| 容量不符 | 1MiB archive写入4MiB新设备被拒绝，真实GnW.flash调用0，设备文件SHA不变 |
| 损坏归档 | 损坏bank1文件后restore在backend factory创建前拒绝；backend opens0、Flash writes0 |
| 中断读回 | 真实Flash写入后注入bank2宿主读回损坏；仅bank1记为verified completed，bank2已写但未验证，ext未写，archive未变，CPU暂停；这是注入传输错误，不是实机故障证据 |
| 串联CLI | disable-debug→backup partial→restore bank2→disable-debug实际执行，全程单GDBclient且结束连接归零；此前真实复现第二客户端超时，修复后通过 |
| 连续manager命令 | CLI自有/injected shell连接×partial/complete捕获四场景：flash bank2→backup→flash→整bank dump→restore bank2→整bank dump→flash→整bank dump，各阶段完整256KiB逐字节读回一致；调用者连接不关闭，最终单GDBclient归零。借用结束只清宿主started/context/retry/geometry缓存，未提前reset/resume原始capture |
| 旧格式兼容 | 去掉新format/version/coverage元数据，保留原oldscript格式，实际完整restore成功 |
| HTTP fetch | 实际loopback服务，manifest及六文件正确拉取/校验；损坏payload拒绝且无完成dest；两路径都backend opens0 |

索引`out/gwemu-completion/backup/acceptance-index.json`汇总12次native、23次worker；证据`out/gwemu-completion/backup/*.json`记录native/worker PID、binary/firmware身份、每操作hash与elapsed。测试每项最后确认本任务native/worker已reap，未操作原PID16603。

## 仍需修复和关闭的检查

独立规范首次审查发现HTTP总截止、安全相对REMOTE_DIR、原子不覆盖发布三项缺陷，均已增加负例并修复。HTTP独立传输子进程由同一总截止监督，能够终止DNS/缓冲header/body dribble；SCP保留安全相对路径；macOS实际renamex_np(RENAME_EXCL)边界碰撞保留既有目录inode及验证staging。规范复审APPROVED，集中最终104 passed、zero skips。质量审查另发现诊断写失败会越过halt、串联命令第二GDB客户端，均有RED/GREEN修复；失败/KeyboardInterrupt/SystemExit先halt再best-effort诊断，借用既有后端不reopen/close caller。质量复审另在真实native复现缓存失效导致下一flash停滞，增加6种stateful RED/GREEN及上述四种actual链后修复；manager全套最终232 passed、1项既有stockasset-dependent skip；其余新功能无skip。独立最终质量复审APPROVED，另行跑过104项集中与10项真实native验收，均zero skips。

实际SSH远端传输尚未验证；SCP argv/manifest-first/文件允许列表/长度/超时由受控runner单测覆盖，不能当作真实SSH主机测试。实机与实体手柄仅用户豁免。源十hash、安全审计、旁manager clean identity及原16603仍运行均核对；manager clean commit已公开发布到orochi115/gnwmanager:gnw-emu，HEAD和remote同为5c3629053996800264173328b5c48b49572e74eb。上传固件仍是旧7a82d65构建；父gitlink/tests/docs仅本地提交。完整session接口、工具链命令与唯一gwemu产品收尾继续独立推进。
