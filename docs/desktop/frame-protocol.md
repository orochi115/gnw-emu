# GNWF v1 像素通道

QEMU显示监听器获取合成及背光后的 surface，拥有转换后RGBA快照，再使用 QIOChannelSocket/GLib非阻塞watch发送。renderer不轮询screendump。显示监听刷新约16ms；TCP_NODELAY启用。

头固定64字节，小端。magic=GNWF，version=1；pixelFormat=1为紧密RGBA8888（alpha255）。尺寸1..2048，单帧≤16MiB。只FRAME有载荷。

| 偏移     | 字节 | 字段                                         |
| -------- | ---- | -------------------------------------------- |
| 0        | 4    | GNWF                                         |
| 4        | 2    | version                                      |
| 6        | 2    | type：HELLO1、HELLO_ACK2、FRAME3、FRAME_ACK4 |
| 8        | 4    | headerBytes=64                               |
| 12       | 4    | payloadBytes                                 |
| 16       | 8    | sequence                                     |
| 24       | 8    | captureTimeNs（QEMU宿主单调时钟）            |
| 32/36/40 | 各4  | width/height/stride=width×4                  |
| 44       | 4    | pixelFormat                                  |
| 48       | 4    | maxFrameBytes（握手协商上限）                |
| 52/56    | 4/8  | reserved=0                                   |

QEMU连接主机预先监听的随机loopback端口，先HELLO/HELLO_ACK，之后FRAME。每帧完整校验后返回相同sequence的ACK；未知/重复/倒序/超限字段断开。TypeScript序号用BigInt，不转为Number。握手sequence=0、captureTimeNs=0；FRAME_ACK只有type/sequence非零。握手pixelFormat=1、maxFrameBytes>0。

QEMU最多一帧发送/等ACK，另保留一个最新待发快照；部分写入的所有权独立于可变surface。utility另最多一帧已交给renderer、一帧最新待绘制。消费ACK只在Canvas实际绘制后发送。慢消费只替换pending，不扩展IPC队列；恢复后绘制最新帧。

网络ACK只代表完整收包，绘制ACK只代表画面呈现，都不代表游戏输入响应。captureTimeNs来自QEMU，不与renderer的performance.now直接相减；同源接收到绘制耗时单独报告。帧龄/分辨率/队列为诊断信息，不展示成常驻UI。

`externals/gwemu/hw/arm/gnw_h7b0_frame_protocol.h` 和 `desktop/src/shared/frame-protocol.ts` 定义同一布局；Python真实 gwemu 测试验证字节、分包、透明度与背压。未知协议立即停止该显示连接；不自动重连，统一清理后重新加载创建新运行。
