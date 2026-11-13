param([ValidateSet('manager', 'retrogo-sd', 'retrogo-flash')][string]$Target = 'manager', [string]$Output, [string]$Assets, [string]$Selection)
. "$PSScriptRoot\common.ps1"
$arm = Join-Path $env:GNW_TOOLCHAIN_ROOT 'gcc-arm-none-eabi-10.3-2021.10\bin'
if (!(Test-Path "$arm\arm-none-eabi-gcc.exe")) { throw 'ARM GNU toolchain missing. Run bootstrap.ps1.' }
$python = Join-Path $ProjectRoot 'build\windows-python\Scripts\python.exe'
if (!(Test-Path $python)) { throw 'Python environment missing. Run bootstrap.ps1.' }
$rootQuoted = Quote-Sh $ProjectRoot.Replace('\', '/')
$armQuoted = Quote-Sh $arm.Replace('\', '/')
$flashArguments = ''
if ($Target -eq 'retrogo-flash') {
    if (!$Output -or !$Assets -or !$Selection) { throw 'retrogo-flash requires -Output, -Assets and -Selection.' }
    $flashArguments = '--output ' + (Quote-Sh ((Resolve-TaskPath $Output).Replace('\', '/'))) + ' --assets ' + (Quote-Sh ((Resolve-TaskPath $Assets).Replace('\', '/'))) + ' --selection ' + (Quote-Sh ((Resolve-TaskPath $Selection).Replace('\', '/')))
}
$pythonQuoted = Quote-Sh $python.Replace('\', '/')
Invoke-Msys @"
cd $rootQuoted
export GCC_PATH=`$(cygpath -m $armQuoted)
export PYTHON=`$(cygpath -u $pythonQuoted)
export PATH=`$(cygpath -u $armQuoted):`$PATH
mkdir -p build/windows-bin
printf '#!/bin/sh\nexec "%s" "`$@"\n' "`$PYTHON" > build/windows-bin/python3
printf '#!/bin/sh\nexec "%s" "`$@"\n' "`$PYTHON" > build/windows-bin/python
chmod +x build/windows-bin/python3 build/windows-bin/python
export PATH=`$PWD/build/windows-bin:`$PATH
case '$Target' in
manager)
    mkdir -p build/gnwmanager-ram-release
    python scripts/gnwmanager-build-manifest.py check externals/gnwmanager build/gnwmanager-ram-release
    make -C externals/gnwmanager OS=MSYS -j4 BUILD_DIR=../../build/gnwmanager-ram-release DEBUG=0 OPT=-Os gnwmanager/firmware.bin
    python scripts/gnwmanager-build-manifest.py record externals/gnwmanager build/gnwmanager-ram-release
    ;;
retrogo-sd) scripts/build_retrogo_sd.sh ;;
retrogo-flash) python scripts/build_retrogo_flash.py $flashArguments --gcc-path "`$GCC_PATH" --python-venv "`$PWD/build/windows-python" ;;
esac
"@
