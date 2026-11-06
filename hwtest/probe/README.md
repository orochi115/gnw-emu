# hwtest/probe：在真机上读取运行中的状态（不暂停 CPU）

这些 OpenOCD 脚本都在接着 ST-Link 的机器上运行：

```sh
openocd -f interface/stlink.cfg -c "transport select swd; adapter speed 1800; reset_config none" \
        -f target/stm32h7x.cfg -f <脚本>.tcl
```

除 `watch_flag.tcl` 外，其余脚本都通过 AHB-AP 在固件运行时读取，不会暂停 CPU。原厂进入待机后读取会失败，短按电源键唤醒即可。

| 脚本 | 用途 |
|---|---|
| `peek.tcl` | 原厂的 TIME 引脚选择字节（0x2000ab92）、GPIO 输入、DBGMCU、RCC_RSR、PWR、OPTSR、UID |
| `watch_flag.tcl` | 先复位并暂停，在 0x2000ab92 上设 DWT 写观察点，记录每次写入的 pc/lr/值。脚本会复位芯片，原厂随后进入待机 |
| `time_prompt.tcl` | 在 "PRESS TIME BUTTON" 画面上采样选择字节、PC5（TIME）、PA2（PGOOD）、PC8 |
| `adc.tcl` | 原厂运行时的电池 ADC2 读数和配置 |

2026-11-06 在一台 Zelda 上的结果：

- 原厂开机时开上拉读 PC8（Zelda 在 0x0800ee8e，Mario 在 0x08006300）。Zelda 板上 PC8 接地，读到低电平就把选择字节置 1，之后 TIME 从 PC5 读，PA2 作为充电 PGOOD，电量阈值用 Retro-Go 的刻度。
- 观察点抓到的写入发生在 0x0800eaa6，值来自 PC8 检测函数的返回值。
- 修复后，模拟器的选择字（0x01010004）和 GPIOA_PUPDR（0x64000001）与真机读数一致。
- 原厂 ADC2 采样 810.5 周期、1024 倍过采样，接近满电（插 USB）时读数约 13165，和 Retro-Go 是同一刻度。
- 真机首次开机画面短按 TIME：Triforce 闪约半秒后进入 12:00 时钟，与模拟器一致。
