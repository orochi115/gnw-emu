# JSON 文件格式

UTF-8 标准 JSON；`formatVersion: 1`。拒绝未知字段、错误类型和未知版本；不读取旧应用格式，不迁移旧用户数据。

```json
{
  "formatVersion": 1,
  "id": "7c5b871e-4d8b-4e53-a7ed-b7762b6a69de",
  "model": "zelda",
  "internalFlash": "bank1.bin",
  "externalFlash": "flash.bin"
}
```

文件名必须以 `.gnw.json` 结尾。UUID 是存档身份；model 为 zelda/mario。镜像路径相对配置文件目录，也接受绝对路径。制作时尽量保存相对路径，可整体移动。

可选 bank2Flash（≤256 KiB）、sdCard、sdWiring（spi1/ospi，要求有 sdCard，省略为 spi1）、deviceUid（24 位十六进制；不同于 UUID）。制作 UI 不提供 deviceUid 输入；高级用户仍可手改 JSON。ospi 指外部 Flash 引脚上的软件 SPI。文件必须可读、非空。内部 Flash 应 ≤1 MiB，外部 Flash ≤256 MiB；外部 Flash 不要求固定 1/4 MiB，也不校验为某一游戏固件。尺寸边界用于阻止明显无效输入；固件行为仍由 QEMU 判断。

`session.json` 保存 formatVersion、电量 battery（整数0..100）、usbPower（boolean）、rtc（host 或 YYYY-MM-DDTHH:mm:ss）、batteryLifeMinutes、chargeTimeMinutes（非负整数，0 禁用相应变化）。默认100、false、host、480、180。

`settings.json` 保存 formatVersion、language（system/zh-CN/en，默认 system）、showChassis（是否显示机身）、audio、realtime；后三项默认 true。缺文件按默认写入，损坏文件报错而不是静默覆盖。边框切换使用串行的读取/修改/原子保存，保留其他偏好；保存失败时 UI 和原生菜单保留之前的选择。

`realtime` 是内核相关的节奏偏好：legacy 为 true 时使用指令计数和机器限速器，为 false 时关闭这两项；false 不保证游戏快进。迁移开发入口的 gwemu 两种值均使用普通 TCG 时钟，运行时随宿主单调时间推进、暂停时冻结，不传 legacy 的限速参数。偏好继续保存供 legacy 使用。虚拟时钟验收不代表所有游戏帧率或扬声器延迟已验证，见 [时钟验收](../research/2026-11-12-gwemu-clock.md)。

controls 为共享输入配置（version: 1），包含 bindings、defaultTurboHz（6/10/15）和 devices。每条 binding 保存 id、target、inputs、modifiers 和 turbo；普通按键单输入、无修饰键，热键支持键盘修饰键或同设备按钮组合、无连发。turbo 为 null、default 或 6/10/15。devices 按接口指纹保存 enabled 与 deadzone；运行时连接序号不保存。缺少 controls 的现有设置使用默认值，保存失败不会启用新映射。见 [自定义按键](controls.md)。

clockDock 默认为 none，可选 topLeft/topRight/bottomLeft/bottomRight。角落贴合当前屏幕的可用工作区，拖动取消后保存 none。

显示偏好还包括 normalScale（默认 4）、clockScale（默认 1）、clockMode（默认 false）和可选 clockBounds（x/y/width/height，可选 displayId）。倍率是 QEMU 源像素相对于输出像素的大小，范围 0.05..64；两个模式独立保存。clockMode 只恢复显示方式，不自动加载 ROM。

recentRoms（默认 []）是最多十个成功加载的配置文件绝对路径，最近的在前，重复加载置顶；由主进程保存，与 QEMU 和 ROM 身份无关。CLI、加载对话框及保存并加载均记录；失败或取消不记录。清空最近记录只清除此数组，当前游戏和存档继续保留。

开发默认 `<项目>/UserData`；打包默认系统应用数据目录下的 UserData；`--user-data-dir=/绝对/可写路径` 显式指定便携数据目录。Electron 自己的缓存位于该目录的 electron-host，和业务 JSON 分开。

`UserData/sessions/<id>/` 存 bank1.bin、flash.bin、可选 bank2.bin/sdcard.img 的工作副本。新会话先完整复制到暂存目录，成功后原子发布；已有存档绝不重新复制覆盖。session.json 不重复记录这些可推导路径。每次运行的退出快照位于 `runs/<runtimeSessionId>/state.json`，含 formatVersion、battery、usbPower。

每次制作（包括覆盖同名配置）都生成新 UUID。旧存档保留。脚本 `ensure` 对相同 JSON 配置复用身份；输入改变时报错，`--fresh` 明确建立新身份，不删除旧存档。源码路径中的逗号按 QEMU 规则转义为双逗号；应用从不拼接 shell 命令。

JSON 保存使用同目录唯一临时文件、fsync、rename。写入失败不会以截断的新内容替代旧文件；突然断电后目录元数据的绝对持久性依赖文件系统，当前未做目录 fsync。
