param([switch]$SkipArm, [switch]$CoreToolchain, [string]$Mirror = 'https://mirrors.tuna.tsinghua.edu.cn/msys2')
. "$PSScriptRoot\common.ps1"
foreach ($command in @('node', 'python', 'git', 'tar.exe', 'curl.exe')) {
    if (!(Get-Command $command -ErrorAction SilentlyContinue)) { throw "Install $command and reopen PowerShell first (Node.js 24, Python 3.11+ and Git for Windows)." }
}
if ([int]((& node --version).TrimStart('v').Split('.')[0]) -lt 24) { throw 'Node.js 24 or newer is required.' }
New-Item -ItemType Directory -Force $env:GNW_TOOLCHAIN_ROOT | Out-Null
$archive = Join-Path $env:GNW_TOOLCHAIN_ROOT 'msys2-base-x86_64-20260927.tar.xz'
if (!(Test-Path "$MsysRoot\usr\bin\bash.exe")) {
    & curl.exe -fL --retry 3 -o $archive 'https://github.com/msys2/msys2-installer/releases/download/2026-09-27/msys2-base-x86_64-20260927.tar.xz'
    if ($LASTEXITCODE) { throw 'MSYS2 download failed.' }
    if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLower() -ne 'ea2f31a0b6ade63914ce441ffb022f0f6aa96982bfefa2326460a26d5fb01322') { throw 'MSYS2 archive checksum mismatch.' }
    & tar.exe -xf $archive -C $env:GNW_TOOLCHAIN_ROOT
    if ($LASTEXITCODE) { throw 'MSYS2 extraction failed.' }
}
# Initialize a newly extracted distribution before installing packages.
$env:MSYSTEM = 'UCRT64'
& "$MsysRoot\usr\bin\bash.exe" -lc 'true'
if ($LASTEXITCODE) { throw 'MSYS2 initialization failed.' }
$mirrorQuoted = Quote-Sh $Mirror.TrimEnd('/')
Invoke-Msys @"
mirror=$mirrorQuoted
printf 'Server = %s/mingw/`$repo\nServer = https://repo.msys2.org/mingw/`$repo\n' "`$mirror" > /etc/pacman.d/mirrorlist.mingw
printf 'Server = %s/msys/`$arch\nServer = https://repo.msys2.org/msys/`$arch\n' "`$mirror" > /etc/pacman.d/mirrorlist.msys
pacman --disable-download-timeout -Sy --noconfirm --needed mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-python mingw-w64-ucrt-x86_64-python-pip mingw-w64-ucrt-x86_64-ninja mingw-w64-ucrt-x86_64-cmake mingw-w64-ucrt-x86_64-pkgconf mingw-w64-ucrt-x86_64-glib2 mingw-w64-ucrt-x86_64-pixman mingw-w64-ucrt-x86_64-libpng mingw-w64-ucrt-x86_64-xz make git diffutils patch tar unzip wget vim mingw-w64-ucrt-x86_64-mtools
"@
if (!$SkipArm) {
    $name = 'gcc-arm-none-eabi-10.3-2021.10'
    $archiveName = "$name-win32"
    $zip = Join-Path $env:GNW_TOOLCHAIN_ROOT "$archiveName.zip"
    if (!(Test-Path "$env:GNW_TOOLCHAIN_ROOT\$name\bin\arm-none-eabi-gcc.exe")) {
        & curl.exe -fL --retry 3 -o $zip "https://developer.arm.com/-/media/Files/downloads/gnu-rm/10.3-2021.10/$archiveName.zip"
        if ($LASTEXITCODE) { throw 'ARM toolchain download failed.' }
        & tar.exe -xf $zip -C $env:GNW_TOOLCHAIN_ROOT
        if ($LASTEXITCODE) { throw 'ARM toolchain extraction failed.' }
    }
}
if ($CoreToolchain) {
$name='arm-gnu-toolchain-15.2.rel1-mingw-w64-x86_64-arm-none-eabi'
$zip=Join-Path $env:GNW_TOOLCHAIN_ROOT "$name.zip"
$url="https://gitlab.arm.com/api/v4/projects/tooling%2Fgnu-toolchains-for-arm/packages/generic/gnu-toolchain/15.2.rel1/$name.zip"
if (!(Test-Path $zip)) { & curl.exe -sSfL --retry 3 -o $zip $url; if($LASTEXITCODE){throw 'ARM15 download failed'} }
& curl.exe -sSfL --retry 3 -o "$zip.sha256asc" "$url.sha256asc"
if($LASTEXITCODE){throw 'ARM15 checksum download failed'}
$expected=((Get-Content "$zip.sha256asc" -Raw).Trim() -split '\s+')[0]
if($expected.Length -ne 64 -or (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $expected.ToLower()){throw 'ARM15 checksum mismatch'}
if (!(Test-Path "$env:GNW_TOOLCHAIN_ROOT\$name\bin\arm-none-eabi-gcc.exe")) { New-Item -ItemType Directory -Force "$env:GNW_TOOLCHAIN_ROOT\$name" | Out-Null
        & tar.exe -xf $zip -C "$env:GNW_TOOLCHAIN_ROOT\$name"; if($LASTEXITCODE){throw 'ARM15 extraction failed'} }
}
Push-Location $ProjectRoot
try {
    git -c core.autocrlf=false submodule update --init --recursive externals/gwemu externals/gnwmanager externals/retro-go-sd externals/game-and-watch-patch
    if ($LASTEXITCODE) { throw 'Submodule initialization failed.' }
    $venv = Join-Path $ProjectRoot 'build\windows-python'
    if (!(Test-Path "$venv\Scripts\python.exe")) { & python -m venv $venv; if ($LASTEXITCODE) { throw 'Python environment creation failed.' } }
    & "$venv\Scripts\python.exe" -m pip install -e "$ProjectRoot\externals\gnwmanager" -r "$ProjectRoot\externals\retro-go-sd\requirements.txt" -r "$ProjectRoot\externals\game-and-watch-patch\requirements.txt" pytest pytest-mock qemu.qmp
    if ($LASTEXITCODE) { throw 'Python tool installation failed.' }
    Push-Location desktop
    try { Invoke-Npm @('ci', '--no-audit', '--no-fund') } finally { Pop-Location }
} finally { Pop-Location }
Write-Host 'Windows toolchains ready. Run scripts\windows\build.ps1.'
