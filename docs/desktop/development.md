# 开发与构建

先按根README构建本机QEMU。Node使用支持 import.meta.dirname 的现代版本（本次Node24），锁定的Electron39自带Node运行时。桌面发行运行不依赖Python；Python继续用于硬件回归与镜像工具。

```sh
scripts/build.sh
cd desktop
npm ci
npm run dev
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run package:dir
```

main/preload/renderer 分别由electron-vite构建。sandbox preload必须为CJS（index.cjs），主进程/utility为ESM；禁止把Node业务模块导入renderer。独立Node CLI在dist-cli，复用core，没有Electron依赖。配置/契约修改后同时更新相应文档及测试。

```sh
# 在项目根目录：
node desktop/dist-cli/cli.js ensure /tmp/example.gnw.json zelda internalFlash=/absolute/bank1.bin externalFlash=/absolute/flash.bin
node desktop/dist-cli/cli.js session-dir /tmp/example.gnw.json
scripts/probe.sh 1
```

ensure复用未改变的新格式配置；--fresh生成新UUID且保留旧存档。create接收JSON字段，总是新UUID。probe使用隔离临时UserData并静音，输出寄存器JSON及截图；不访问应用存档。run/run_sd/run_sd_update保留作为Electron入口，旧的任意QEMU参数和应用环境覆盖已退役；headless通过GnW设置设备参数。

package:dir先stage QEMU到resources/qemu，再electron-builder生成目录包。可用GNW_QEMU_BINARY选择本机原生二进制。固件/用户镜像不打包；QEMU在asar外。macOS用otool复制非系统dylib、修改@loader_path并ad-hoc签名本地QEMU；应用没有开发者签名或notarization。正式分发签名不属于本阶段。

Linux在本机构建，stage需要ldd/patchelf，使用$ORIGIN/lib，不打包glibc。Windows在原生构建环境打包，设置GNW_QEMU_LIB_DIR为构建产物的DLL目录。跨目标生成Electron壳不能替代对应平台的QEMU原生构建与实际运行；详情见validation.md。

```sh
cd desktop
GNW_SOAK=1 npm run test:e2e -- tests/e2e/display-soak.spec.ts
GNW_PACKAGE_TEST=1 npm run test:e2e -- tests/e2e/packaged.spec.ts
```

十分钟测试显式启用，避免日常单元测试等待；目录包测试接受GNW_PACKAGE_BINARY覆盖平台路径。测试不提交固件画面，产物位于根out/ui-validation和desktop/test-results。

父目录 stock/backup/sd/sd_update wrappers 与 gnw_emu_common.sh 不属于本 Git 仓库；已单独调整为新版入口并自动选择 Electron worktree。详见 launchers.md。

界面语言/原生菜单说明见 localization.md；一键入口支持 --language、--automation 和 --user-data-dir。
