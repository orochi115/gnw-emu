# 原厂启动修复与 legacy/gwemu 设备差异审查

后续状态：本页的未修设备和冷启动调查已由[设备修复与维护判断](2026-11-13-gwemu-device-parity-and-maintenance.md)更新。以下保留当时的证据，失败记录不是当前验收状态。

日期：2026-11-13。旧机器取本地最终历史快照（来源见[迁移历史](2026-11-13-gwemu-migration-history.md)），新机器基于 `a38484468d947ce6447fcc7dec47ebeef041f853`，本次修复为 gwemu `a99dd14`。父仓库仅本地提交。

干净源码 `a99dd14263c0cb5d3a29bedc379f41cf366e8d46` 独立构建成功，native SHA-256 为 `7f1023e8aed4e6cada6eed441ea55c6872001bef4150e4aea035170e47feb6cb`。113 项及 4 项原厂测试均在这一干净产物上重跑通过。`build/gwemu` 指向 `build/gwemu-stock-settings`，默认开发启动脚本使用新产物；原调试构建完整保留在 `build/gwemu-stock-settings-debug-2026-11-13`。manifest 的源码、dirty 状态和实际二进制哈希已核对。既有 macOS 目录包未在本轮重新打包，其历史验收不代表包含这次修复。

## 原厂开机画面 / 12:00 的原因与修复

不是宿主 RTC 初值丢失：原厂固件先读 NOR 中的加密设置，校验失败时显示 PRESS TIME，收到 TIME 后主动初始化 12:00。之前只检查开机 TR/DR，没有按 TIME，漏掉了这个分支。

1. Mario 用 OSPI `0x6B` 读取 `0xfe000`/`0xff000`。旧内核返回真实密文，新内核返回全零；解密后设置 magic/checksum 失效。本次补齐标准 array-read 的 24/32 位命令族及地址长度识别，保持既有 `0xEB`/`0xEC` 路径。新增命令只补功能语义，没有宣称其总线时序模型已完成。
2. Zelda 同样需要 `0x6B`，还使用 CRYP `DATATYPE=2` 的字节交换。新内核忽略 DATATYPE，密文读对后仍解出错误数据。本次在 DIN/DOUT 补齐半字、字节、位交换，key/IV 不交换。
3. GCM FINAL 的长度字需要独立处理：本地 STM32 HAL `HAL_CRYPEx_AESGCM_GenerateAuthTAG()` 明确规定 H7 rev.B+（以及 CRYP_VER_2_2）直接提交未交换的长度。若继续套 payload 的 DATATYPE，明文正确但认证 tag 错误。现在 FINAL 长度绕过输入交换，tag 输出仍按 DATATYPE 处理；独立 NIST GCM 向量验证了加/解密结果与 tag。

修复没有屏蔽固件写 RTC，也没有强制覆盖用户设时。继续使用已有 host RTC 策略：以宿主本地时间初始化，进程中由 `rtc_clock` 推进，允许固件设时，软复位保留日历。跨进程保存用户设时偏移不在本次实现范围内。

## 验证与未通过项

- OSPI 10 条命令 × byte/word 读取：修前 20 例失败（全零），修后 20 例通过；DLR 边界和文件不变均检查。
- FIPS-197 ECB 128/192/256 位 key、加/解密、4 种 DATATYPE：修前 18 例失败、6 例通过，修后 24 例通过。初版夹具 key 地址错误已纠正，失败计数取纠正后的结果。
- NIST GCM payload/tag、加/解密、4 种 DATATYPE：只加 FIFO 交换时 6 例失败、2 例通过；加 FINAL 例外后 8 例通过。没有复制旧内核按消息长度猜测 tag 输入的启发式。
- 直接 native 回归共 113 例通过，覆盖上述 52 例及既有 RTC、充放电、供电域、manager SPI。
- 原厂 Mario/Zelda 副本共 4 例通过：TIME 键不会把 09:00 改成 12:00；同一副本关闭重开两次仍正确；另含手动设时、软复位与冷启动检查。宿主本地时间另有实际启动截图验证。
- 现有 Mario session 的 bank1/flash 副本可正常进入时钟界面，实际 session 文件哈希不变。所有原 ROM 在成功和失败后均复核哈希，native 子进程由夹具退出并回收。
- **额外运行的 Retro-Go RTC 冷启动回归有 2 例失败，不能报告全套固件回归通过。** Flash-only/SD 两组初次启动、设时及软复位日历检查通过，但完整冷启动后不能按既有步骤跳到 Bank 2。Flash-only 用修前干净 `a384844` 产物对照为通过。修后 CPU 停在 stock `0x0800376a`（WFI 后位置），VTOR 为 `0x08000000`；截图会保留冷启动前画面，不能把它当作新帧证据。追加 POWER、重复启动组合键、设 WKUPFR=1 的隔离探针均未恢复。此项列为后续电源/复位路径阻塞，不修改测试来接受假画面或直接改期望为 09:00。

本次关闭的是原厂常规启动问题；不据此重申整个迁移或所有电源路径已经无缺口。既有冷启动验收的结论需受上述新发现限制。

可重复的维护测试：

```sh
.venv/bin/python -m pytest -q tests/test_gwemu_stock_ospi.py tests/test_gwemu_cryp_datatype.py tests/test_gwemu_rtc.py tests/test_gwemu_power.py tests/test_gwemu_supply.py tests/test_gwemu_manager_spi.py
GNW_FIRMWARE_RTC_TEST=1 .venv/bin/python -m pytest -q tests/test_gwemu_rtc_firmware.py -k 'mario or zelda'
```

## 旧内核更完整的设备部分

这里比较具体语义，不以文件长度、stub 注释或型号数量断言整个设备优劣。除了本次 OSPI 读取和 CRYP 数据交换，其余仅审查记录，未一并修改。

| 设备 / 部分 | 旧内核的优势与新内核缺口 | 证据、影响与边界 |
| --- | --- | --- |
| OSPI/NOR 功能模式的 page program | 旧实现检查 WEL，`flash[a] &= data[i]`，在 256 字节页内回绕。新 fallback 在 DR 写入时直接赋值、线性递增，没有该处 WEL 检查 | 同一地址先写 00 再写 FF，不擦除：旧读回 00，新读回 FF。新模型允许真实 NOR 做不到的 0→1，可能掩盖固件擦除/写使能错误。仅比较默认功能模式，不外推到新 timed NOR 路径 |
| DAC | 旧实现支持软件触发、双通道寄存器写入、EN 门控及不同 DHR 视图。新实现主要支持单通道无触发转移 | 软件触发后旧 DOR=ABC、新=0；禁止通道后再写 456，旧保持 ABC、新变 456；双通道写 789/123，旧输出正确、新忽略。没有声称旧实现支持完整模拟波形/真实 DAC 延迟 |
| LCD 背光链路 | 旧 LTDC 从 PA4 GPIO/DAC 输出计算亮度并缩放 RGB；新 renderer 未接入此链路 | 同一 Mario 副本停 CPU 后写 DAC=0：旧画面平均灰度约 126→0；新约 165→165。会影响亮度调节与熄屏表现，属于 DAC→显示集成缺口 |
| LTDC Layer 1 格式 | 旧 renderer 对 Layer 1 解码 ARGB8888、RGB888、ARGB1555、ARGB4444、AL44、AL88 等；新 Layer 1 只接受 RGB565/L8，其他格式直接跳过 capture | 源码明确拒绝不支持的 Layer 1 格式。新 Layer 2 支持多种格式，不能说整个 LTDC 只支持两种格式；旧 pixel helper 的 L4/A4/A8 分支也不能直接当作 LTDC 可选格式，因为旧 PFCR 掩码只有 3 位。此项为源码确认，未追加格式矩阵运行验收 |
| PWR 状态副作用 | 旧 WKUPCR 清 WKUPFR 并自清零；新主要寄存器 shadow，没有这两个副作用。旧 CSSF 至少自清零，新 CSSF 留在 CPUCR | 写 WKUPFR=1，再 WKUPCR=1：旧两寄存器均 0，新均 1。**旧 CSSF 也没有正确清 SBF**：旧代码先屏蔽 bit9 再判断；运行对照仍为 0x40，不能把旧内核当作正确参考。USB/电池供电模型是另一层能力，不能替代 MCU 低功耗/唤醒语义 |
| TIM3/4/6/7 计数器位宽 | 旧按实例选 16/32 位；新 TIM2 块前 6 个实例统一按 32 位处理 | TIM3 CNT 写 0x1FFFF：旧读 0xFFFF、新读 0x1FFFF。TIM2/5 本来就是 32 位，不列为问题。新动态 RCC 时钟、IRQ、OPM 等较丰富，结论只针对位宽 |
| 深睡与唤醒集成 / 当前冷启动路径 | 旧机器有独立的 Standby POWER→复位、Stop WKUP1→唤醒及深睡 SysTick gate；新没有对应的完整协调链路 | 源码差异确定，Retro-Go 冷启动后 WFI 停留也已复现；尚未证明该停留唯一由上述缺失造成，不能直接移植某一 hook 就宣称修好。后续应先完成该具体失败路径定位 |

源码定位（旧目录由本地历史快照保留，复现方式见迁移历史）：

- NOR：`qemu-gnw/hw/arm/gnw/gnw_ospi.c::flash_command_write`；`externals/gwemu/hw/misc/gnw_h7b0_ospi.c` 的 DR fallback。
- DAC：旧 `gnw_dac.c`；新 `gnw_h7b0_dac.c::gnw_h7b0_dac_maybe_transfer`。
- LCD：旧 `gnw_ltdc.c::ltdc_backlight/pixel_get`；新 `hw/display/gnw_h7b0_ltdc.c::gnw_h7b0_ltdc_capture_setup`。
- PWR：旧 `gnw_regs.c::pwr_write`；新 `gnw_h7b0_pwr.c::gnw_h7b0_pwr_write`。
- TIM：旧 `gnw_timer.c::tim_write` 及机器实例 width-mask；新 `gnw_h7b0_tim2.c::gnw_h7b0_tim2_counter_mask`。
- 深睡：旧机器 `gnw.c::gnw_apply_buttons/gnw_systick_gate`；新 GPIO/SoC/PWR 的输入及复位路径。

其他已浏览的 CRYP、JPEG、DMA/MDMA、DMA2D、GPIO/EXTI、RCC、HASH/CRC、ADC、SPI/SD、RTC/备份域和 SAI 路径，没有在本次有限审查中证明旧实现整体优于新实现。新 CRYP 另有 CCM，HASH 有 HMAC，JPEG 编解码、DMA 请求和 RCC 时钟也有扩展；没有对所有模式做硬件级矩阵验收。RTC 的跨进程用户设时偏移持久化两边都不能按现有证据宣称完整，不列为旧内核独有优势。

## 后续顺序与本地证据

优先定位新发现的 Retro-Go 冷启动/WFI 路径；随后补 NOR 编程约束及背光链路，再处理 DAC、PWR 副作用、TIM 位宽和较少使用的 Layer 1 格式。后续修复分别建立失败用例，不以此清单要求一次实现所有 STM32 设备。

本地诊断材料在 `out/rtc-legacy-comparison/`：OSPI/CRYP 两内核 MMIO trace、Mario 设置校验反汇编、`device-probe/results.json`、`backlight-results.json`、修前 ECB/GCM 测试日志及 Retro-Go baseline 日志。原厂重开证据为 `out/gwemu-rtc/stock-reopen/{mario,zelda}/results.json`。这些 trace/ROM 副本不发布到仓库。
