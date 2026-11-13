param([string]$Profile, [Parameter(ValueFromRemainingArguments=$true)][string[]]$AppArguments)
. "$PSScriptRoot\common.ps1"
$profilePath = if ($Profile) { (Resolve-TaskPath $Profile) }
$cli = Join-Path $ProjectRoot 'desktop\dist-cli\cli.js'
if (!(Test-Path $cli)) { throw 'Build the desktop first with scripts\windows\build.ps1.' }
[string[]]$profileArguments = @()
if ($profilePath) { $profileArguments = @($profilePath) }
Push-Location $ProjectRoot
try {
    & node $cli launch @profileArguments @AppArguments
    if ($LASTEXITCODE) { throw "Desktop launch failed (exit $LASTEXITCODE)." }
} finally { Pop-Location }
