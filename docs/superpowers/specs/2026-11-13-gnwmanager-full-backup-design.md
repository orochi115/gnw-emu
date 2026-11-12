# gnwmanager 完整备份迁移设计

实现原迁移设计阶段二。用户已授权推进到底并跳过实机/实体手柄验证；保持模拟器全部边界，不移除backup直到兼容与恢复证据成立。

## 方案与接口

推荐在manager增加独立full_backup模块与四个CLI命令backup、verify-backup、restore-backup、fetch-backup；复用GnW固件读写Flash，原始读取直接用backend。继续依赖旧OpenOCD脚本无法统一工具链；仅封装旧脚本也无法在QEMU当前session安全capture。选择实现manager内部API，CLI薄封装，archive校验与设备操作分离。

backup输出两完整256KiB内部bank、探测全容量外Flash，以及optbytes.bin(0x52002000,256)、itcm.bin(0x0,65536)、rtc_bkp.bin(0x58004500,128)。首先halt并在不reset、不上传固件、不写mailbox情况下直接backend双读内部bank和三extras。GDB连接新增resume_on_connect=False（既有默认True不变），CLI backup在open前选择；原始捕获无法从失败里偷偷回退为reset/manager读取。完整模式完成现场捕获后才允许start_gnwmanager、探测外Flash/双读；skip-ext明确生成partial归档。现场capture默认保持暂停，CLI可显式resume；session模式由UI运行状态/操作类型协调。

所有双读逐块比较完整数据，短读/不一致立即失败；失败保留partial诊断，不发布完成manifest。输出目录必须不存在，不覆盖旧backup。新manifest增加format/version/coverage，保留created/regions/files/ext_size兼容字段。文件元数据size/sha1/sha256，固定允许六个filename与region地址；验证拒绝路径逃逸/符号链接、未知region/file、无files、错误类型/大小/hash、容量不匹配，旧无version的gnw_full_backup manifest仍严格可读。partial归档可验证，只能restore存在的选定Flash区域，不允许extras写回。

restore先验证全部归档和选择项，再确认YES（--yes用于明确授权自动化），才连接/启动manager、检查RDP0/容量并调用gnw.flash；每个完整region读回SHA一致才成功。未知region、损坏或错误容量必须在Flash写入前失败；连接失败/写入中断/读回不一致报告部分完成，archive保持不变。ITCM/options/RTC始终只归档，不恢复，不触发lock/unlock。

fetch-backup支持原HOST:REMOTE_DIR的scp参数数组（无本地shell拼接/通配符依赖），先到新staging目录，严格验证后rename到新目的地；不覆盖既有dest。另支持HTTP(S) manifest+允许列表文件下载，长度/超时上限与同一校验器，供实际loopback HTTP验收。错误传输/损坏manifest或文件不得出现完成目的地；保留失败staging用于诊断。路径名仍限制六文件，不能由远程manifest写任意路径。SSH实际设备/服务器兼容未实测，参数与错误/校验路径用模拟runner覆盖，HTTP真实传输覆盖核心remote能力。

## 文件与验证

manager gnwmanager/full_backup.py：archive schema、流式hash与双读capture、restore/fetch；cli/_backup.py与cli/__init__.py/main.py薄接入；ocdbackend/gdb_backend.py增加无resume连接。manager tests/test_full_backup.py覆盖legacy/new、空/恶意/短读/差异、原始先于reset/mailbox、无extras写、restore损坏前零写和读回不一致，tests/test_gdb_backend.py证明无resume。父tests/test_gwemu_backup.py用实际TCG/GDB和真实manager固件临时副本验证原始ITCM/RTC/RAM现场、完整backup→改变→选择restore/读回、旧归档、loopbackHTTP成功与损坏失败。

不执行实机，不碰原ROM/SD或产品session；两子模块源码各自提交、公开manager发布沿用已有授权，父gitlink/tests/docs仅本地。GDB默认连接与unlock流程保留。阶段三session discovery/lease另设计实现，完整CLI流程和唯一kernel切换在全路线收尾完成。
