# gwemu 上的 gnwmanager RAM 管理固件验收

日期：2026-11-12。依据已确认的 gwemu 工具链迁移设计，范围为阶段一的 RAM 管理固件兼容性。前一存档批次为父仓库 da5f7e3 / 原生 830192d；默认仍为 legacy。

## 目标与方案

在隔离 gwemu 进程中使用固定版本 gnwmanager 的实际 GDBBackend、GnW API 和 RAM 固件，证明它能进入管理邮箱 IDLE、发现正确 Flash 容量、计算哈希、擦除/编程/读回并启动应用。复制镜像覆盖 Mario、Zelda、64 MiB Flash-only Retro-Go，以及 SD 两种接线。测试完成后退出重开核对实际文件持久化，源镜像不变。

采用实际 backend/API 是主验收路径。原始 GDB RSP 或 gdb+ELF 用作失败定位，不能以手工修改邮箱/绕过固件替代成功证据。只做宿主模拟响应不能覆盖 HAL 和外设，因此仅用于实际发现的传输错误回归。

不在本批增加 UI 会话发现、管理 lease RPC、外部调试器交接或默认 GDB 端口；这些属于阶段三。也不执行实机写入、完整备份迁移或旧仓库退休。本批所有端点只绑定本机，创建并显式连接实验实例，原产品 PID16603 不参与。

## 来源与隔离

gnwmanager 子模块当前固定 dec4fdc9cb027f4c0df4e18984ce2ae29ce28df2，先从该源码构建 RAM 固件，记录 revision、dirty 状态、编译器版本、命令和 ELF/bin SHA。Python 使用独立验收 venv 和同一源码包。初始化固定嵌套 patch 子模块满足打包元数据，不改其 revision。

gwemu 使用已验收的 clean savestate 产物。临时 session 挂载合成或真实镜像副本，原厂 bank 不足部分按现有 gwemu 契约填 ff；真实 SD 也复制。全流程 finally 复核源大小/哈希、退出实验子进程、释放 socket 和观察线程。旧 session、legacy 槽位及 .superpowers 不变。诊断与截图存放忽略目录 out/gnwmanager-ram/。

## 分层验收

1. GDB：实际握手、寄存器读写/恢复、RAM 多包传输、halt/resume/reset。对照目标描述解释寄存器身份；读取长度和错误必须严格。当前 backend 固定 xpsr=16，但 gwemu ARM M-profile XML 指定 regnum=25，应实测并以回归驱动必要修复，不扩大成完整通用调试器。供电丢失后不能因连接/恢复自动执行。
2. 固件：实际 start_gnwmanager 加载 0x240e6800、初始化寄存器、继续并等待 IDLE，核对固件运行 PC、邮箱、Flash 容量/擦除粒度及管理显示。每个完整 API 实验（连接、上传、IDLE、Flash、SD、应用重启）由父进程拥有 gwemu、监督独立 API worker，设置不可因状态变化重置的 monotonic 总期限。manager 自身的无进展超时不是总期限。超时必须失败、终止并 join worker、退出并 wait gwemu、关闭 socket/观察者，并 finally 检查源哈希；初始预算连接/启动30秒，Flash180秒，SD240秒，可按测量记录调整。
3. Flash：外部只读 HASH 使用实际 read_hashes；SRAM 压缩/解压及内部双 bank 的 HASH 通过实际 program/flash 的固件 HAL HASH 与 sha256bank 校验，并与独立 Python digest/readback 对照。覆盖压缩/未压缩；外部 high-level flash 使用超过256 KiB payload跨context，不把单次program超过256 KiB当合法。边界包括负对齐offset、起点等于/超过容量、终点超过容量、擦除/编程取整后越界及合法末块，外部HASH包括负/非法size与end。拒绝需发生在erase/program邮箱提交前，完整Flash哈希不变；保留显式whole-chip erase语义。使用明确实验范围，检查非目标范围与退出重开持久化，只作用副本。
4. 应用与介质：三类真实固件在管理操作后通过受支持路径启动，观察 guest 执行和显示；选择未使用范围或先经实际 API 恢复受改动的副本，核对预期完整bytes后才计入应用重启成功。SD 管理固件在 spi1/ospi 两种接线读写临时文件并核对哈希/目录和退出重开。RTC/HASH/显示等真实依赖按失败证据补模型，保留原硬件行为和现有回归。

## 修复与完成条件

先保留失败证据，再在正确层修复。manager 的寄存器/传输缺陷在 backend 层修复，宿主范围拒绝在 GnW/validation 层最小修复并补单元回归，guest 外设缺口在原生模型修复；实际证实的 manager 固件驱动协议缺陷在其源码层修复（如 SD 多块读取需逐块处理 CRC/token），不得在模拟器插入虚假等待字节迎合错误假设；不通过替换 manager 固件常量、注入成功邮箱或放宽校验来通过。必要模型变更必须兼容完整 savestate，并重跑受影响的原生、固件及桌面检查。

每个修复均需独立规范与质量检查。本批报告区分实际已验证命令与未验证的管理功能，诚实保留 NOR WEL/1→0/时序、内部 PG 和物理 VBAT/RDP 的边界。进入 IDLE 或完成一次刷写不能代表完整 gnwmanager 工具链通过。

全部相关测试通过且源哈希/进程安全、clean artifact、独立最终审查完成后，父仓库仅本地提交。现有原生发布授权继续适用；若需要新的 manager fork/发布身份，先做完可审查变更再按具体目标处理。默认内核和历史数据保留。
