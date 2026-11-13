param([string[]]$Cores = @('LCD-Game-Emulator'))
. "$PSScriptRoot\common.ps1"
$name = 'arm-gnu-toolchain-15.2.rel1-mingw-w64-x86_64-arm-none-eabi'
$arm = Join-Path $env:GNW_TOOLCHAIN_ROOT "$name\bin"
if (!(Test-Path "$arm\arm-none-eabi-gcc.exe")) { throw 'Install core toolchain with bootstrap.ps1 -CoreToolchain first.' }
$python = Join-Path $ProjectRoot 'build\windows-python\Scripts\python.exe'
if (!(Test-Path $python)) { throw 'Run bootstrap.ps1 first.' }
$allowed = @('fceumm','tgb-dual','SMSPlusGX','gwenesis','prosystem','potator','caprice32','blueMSX','LCD-Game-Emulator','pce-go')
foreach ($core in $Cores) { if ($core -notin $allowed) { throw "Unknown core: $core" } }
$rootQuoted = Quote-Sh $ProjectRoot.Replace('\', '/')
$armQuoted = Quote-Sh $arm.Replace('\', '/')
$pythonQuoted = Quote-Sh $python.Replace('\', '/')
$coreList = ($Cores | ForEach-Object { Quote-Sh $_ }) -join ' '
Invoke-Msys @"
cd $rootQuoted
export GCC_PATH=`$(cygpath -m $armQuoted)
export PATH=`$(cygpath -u $armQuoted):`$PATH
mkdir -p build/windows-bin
printf '#!/bin/sh\nexec "%s" "`$@"\n' $pythonQuoted > build/windows-bin/python3
chmod +x build/windows-bin/python3
export PATH=`$PWD/build/windows-bin:`$PATH
for name in $coreList; do
    src=externals/cores/`$name-retro-go-sd
    git submodule update --init --recursive "`$src"
    tag=`$(git -C "`$src" describe --tags --exact-match)
    make -C "`$src" -j4 all CORE_VERSION="`$tag"
    if [ "`$name" = blueMSX ]; then make -C "`$src" bios; fi
    echo "Built `$name `$tag (see `$src/build and its packed .bin)"
done
"@
