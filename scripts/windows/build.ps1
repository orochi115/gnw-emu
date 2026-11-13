param([switch]$Package)
. "$PSScriptRoot\common.ps1"
$rootQuoted = Quote-Sh $ProjectRoot.Replace('\', '/')
Invoke-Msys @"
cd $rootQuoted
export GWEMU_PYTHON=python
scripts/build_gwemu.sh
"@
# Copy only the transitive DLL imports, so development and packaged executables
# work without MSYS2 in the user's PATH.
& node "$ProjectRoot\desktop\tools\collect-windows-dlls.mjs" "$ProjectRoot\build\gwemu\qemu-system-arm.exe" "$MsysRoot\ucrt64\bin"
if ($LASTEXITCODE) { throw 'DLL collection failed.' }
Push-Location "$ProjectRoot\desktop"
try {
    Invoke-Npm @('run', 'typecheck')
    if ($Package) {
        $env:GNW_QEMU_LIB_DIR = "$ProjectRoot\build\gwemu"
        Invoke-Npm @('run', 'package:dir')
    } else { Invoke-Npm @('run', 'build') }
} finally { Pop-Location }
