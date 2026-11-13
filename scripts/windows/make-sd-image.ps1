param([Parameter(Mandatory=$true)][string]$Output, [string]$Assets, [int]$SizeMb = 256, [switch]$WithUpdate)
. "$PSScriptRoot\common.ps1"
$outputPath = (Resolve-TaskPath $Output)
if (Test-Path $outputPath) { throw 'Choose a new output image; the existing file was not modified.' }
$python = Join-Path $ProjectRoot 'build\windows-python\Scripts\python.exe'
if (!(Test-Path $python)) { throw 'Run bootstrap.ps1 first.' }
$arguments = (Quote-Sh $outputPath.Replace('\','/')) + ' --size-mb ' + $SizeMb
if ($Assets) { $arguments += ' --assets ' + (Quote-Sh ((Resolve-TaskPath $Assets).Replace('\','/'))) }
if ($WithUpdate) { $arguments += ' --with-update' }
Invoke-Msys @"
cd $(Quote-Sh $ProjectRoot.Replace('\','/'))
$(Quote-Sh $python.Replace('\','/')) scripts/make_sd_image.py $arguments
"@
