param([switch]$Package, [switch]$Portable)
. "$PSScriptRoot\common.ps1"
$rootQuoted = Quote-Sh $ProjectRoot.Replace('\', '/')
Invoke-Msys @"
cd $rootQuoted
export GWEMU_PYTHON=python
scripts/build_gwemu.sh
"@
$nativeBuild = if ($env:GWEMU_BUILD_DIR) { Resolve-TaskPath $env:GWEMU_BUILD_DIR } else { Join-Path $ProjectRoot 'build\gwemu' }
Push-Location "$ProjectRoot\desktop"
try {
    Invoke-Npm @('run', 'typecheck')
    if ($Package -or $Portable) {
        $env:GNW_QEMU_LIB_DIR = $nativeBuild
        $env:GNW_QEMU_BINARY = Join-Path $nativeBuild 'qemu-system-arm.exe'
        $env:GWEMU_BUILD_MANIFEST = Join-Path $nativeBuild 'gnw-build-manifest.json'
        Invoke-Npm @('run', $(if ($Portable) { 'package:portable' } else { 'package:dir' }))
    } else { Invoke-Npm @('run', 'build') }
} finally { Pop-Location }
