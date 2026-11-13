$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if (!$env:GNW_TOOLCHAIN_ROOT) { $env:GNW_TOOLCHAIN_ROOT = Join-Path (Split-Path $ProjectRoot -Parent) 'toolchains' }
$MsysRoot = Join-Path $env:GNW_TOOLCHAIN_ROOT 'msys64'
function Invoke-Msys([string]$Code) {
    $bash = Join-Path $MsysRoot 'usr\bin\bash.exe'
    if (!(Test-Path $bash)) { throw 'MSYS2 not found. Run scripts\windows\bootstrap.ps1 first.' }
    $temporary = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString() + '.sh')
    [IO.File]::WriteAllText($temporary, "export PATH=/ucrt64/bin:/usr/bin:`$PATH`nexport PKG_CONFIG_PATH=`${PKG_CONFIG_PATH:-/ucrt64/lib/pkgconfig:/ucrt64/share/pkgconfig}`nset -eu`n" + $Code.Replace("`r`n", "`n"), (New-Object Text.UTF8Encoding $false))
    $previous = $env:MSYSTEM
    $previousErrors = $ErrorActionPreference
    try {
        $env:MSYSTEM = 'UCRT64'
        # PowerShell 5.1 converts redirected native stderr to ErrorRecords.
        # Compiler warnings must not abort a successful native command.
        $ErrorActionPreference = 'Continue'
        & $bash --noprofile --norc $temporary.Replace('\', '/')
        $nativeExit = $LASTEXITCODE
        $ErrorActionPreference = $previousErrors
        if ($nativeExit) { throw "MSYS2 command failed (exit $nativeExit)." }
    } finally {
        $ErrorActionPreference = $previousErrors
        $env:MSYSTEM = $previous
        Remove-Item -LiteralPath $temporary -ErrorAction SilentlyContinue
    }
}
function Quote-Sh([string]$Value) {
    $quote = [string][char]39
    $escape = $quote + [char]34 + $quote + [char]34 + $quote
    return $quote + $Value.Replace($quote, $escape) + $quote
}
function Invoke-Npm([string[]]$Arguments) {
    $previousErrors = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & npm.cmd @Arguments
        $nativeExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousErrors }
    if ($nativeExit) { throw "npm failed (exit $nativeExit)." }
}

function Resolve-TaskPath([string]$Value) {
    # Set-Location does not update .NET's process current directory in PS 5.1.
    return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Value)
}
