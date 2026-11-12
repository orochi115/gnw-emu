# gwemu RDP 模型基础验收计划

> 按 executing-plans 执行既有工具链迁移设计中的 RDP/选项字节基础验收；沿用已授权开发分支，不切换默认或操作真机。

**Goal:** 独立验证固定 gwemu 的选项字节控制、真实 GDB 读写门禁、两 bank 擦除及持久化/存档恢复，明确与 gnwmanager 全流程和实机精度的边界。

**Architecture:** 只新增 tests/test_gwemu_rdp.py，复用 Native/backed/prop 和已有 Rsp，通过 Unix GDB 端点发送真实 m/M 包。qtest 用于模拟寄存器写入和独立物理内存观测，不把 qtest 读写当成受保护调试访问。所有镜像为临时合成副本，包含两完整256KiB bank及1MiB外Flash；测试前后记录固定来源、镜像hash和自有PID。

**Tech Stack:** pytest、QEMU qtest/QMP/真实TCG、GDB RSP；无GUI/真实音频/实机。

父起点779d092，feat/gwemu-migration。native ae00b68951ab44b0dffb265e3f61340d735a68e5，build/gwemu-manager-ram/qemu-system-arm，SHA25669750cd46454dab640d1e0d8c47c04b32ec703d09217a1730775887a99d8ad1a；manager与旁manager保留。原十镜像、产品UserData/session/states、用户.superpowers和原PID16603保持。

## Task 1: Bounded real GDB fixture

- [x] 创建 tests/test_gwemu_rdp.py，复用既有 Rsp，派生测试专用总截止/最大读取量包装器，避免零碎数据反复续期。Unix端点位于Native拥有的短路径socket目录，连接只属于本例。
- [x] 负例验证partial packet受到总截止且收尾关闭自有连接；所有真实GDB例使用TCG并以-S暂停，qtest socket只作寄存器/内存诊断；只有guest用例cont，不执行clock_step。qtest accelerator不支持GDB，首次启动失败已按明确日志纠正，非native保护缺陷。
- [x] 每例目录将参数、PID、产物身份、寄存器/原始RSP结果、前后临时镜像hash、exit状态和stderr立即保存到ignored out/gwemu-rdp/；外部worker总截止90秒，只TERM/KILL/reap新建进程组。

## Task 2: Model acceptance, no assumed native defect

- [x] 错误/逆序/byte option keys不能解锁；只读CUR不可改；有效key解锁后PRG只更新编程影子，OPTSTART才提交；bank2 alias一致；0→1不擦除。
- [x] 参数0x55和其它非AA/CC值0x11，验证两bank首/尾及跨边界GDB m/M拒绝（错误包），整份bank内容不被失败写修改。SRAM调试访问保持可用；外Flash先显式设置OSPI EN=1/FMODE=11，再验证独立调试访问。首次未开启XIP时E14由独立OSPI门禁产生，不能当RDP缺陷。正确1→0提交擦除全部两个bank并保留外Flash/SRAM，真实GDB再可访问。
- [x] 真实TCG合成固件从Flash读取sentinel并写SRAM，证明RDP1调试拒绝与guest CPU执行/读取不是同一通道。程序仅在0→1后继续，不需要通用unlock专用payload。
- [x] 独立合成session进入CC后尝试降到55/AA，保持CC、OPTCHANGEERR、bank不擦除、GDB仍拒绝；不将真实RDP2可逆性或全部硬件限制归为此测试。
- [x] 暖reset及正常退出重开后sidecar保护值与bank内容保持；保护→解除擦除→退出重开后保持AA/全部擦除。
- [x] 保存RDP1状态，解除保护擦除后读回存档，验证全部Flash、sidecar、即时GDB门禁恢复；保存/读取RDP0也恢复可读状态，不读取旧legacy slots。
- [x] 如发现失败，先分类测试前提/模型行为/既有设计边界；不凭源码猜测修native。真实产品缺陷另制定最小修复与必要clean构建/回归计划，不发布未验证代码。

## Task 3: Evidence and closeout

- [x] 执行新增验收及现有savestate/供电/初始化相关回归，不重复无关音频/GUI用例。
- [x] 报告 docs/research/2026-11-13-gwemu-rdp.md，链接迁移目录；明确只是模拟器模型基础测试，不等于manager unlock/reprotect CLI流程、保护ROM专用payload、实机安全机制、物理选项字节或阶段三会话控制验收。
- [x] 十原hash、artifact/两子模块/旁manager与进程核对；独立最终审查；父tests/docs仅本地提交，默认legacy不变。没有native变更则不构建/发布。

命令：GWEMU_BINARY="$PWD/build/gwemu-manager-ram/qemu-system-arm" .venv/bin/python -m pytest -q tests/test_gwemu_rdp.py；相关回归 tests/test_gwemu.py tests/test_gwemu_supply.py tests/test_gwemu_savestate.py tests/test_gwemu_savestate_runtime.py tests/test_gwemu_savestate_peripherals.py。使用ignored外部监督器运行测试，常规沙箱即可。
