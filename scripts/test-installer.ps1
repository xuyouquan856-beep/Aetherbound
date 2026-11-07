param(
  [Parameter(Mandatory = $true)]
  [string]$Installer
)

$ErrorActionPreference = 'Stop'
if (-not $env:RUNNER_TEMP) { throw 'This installer test is for a disposable CI runner.' }

$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$installDir = Join-Path $env:RUNNER_TEMP 'AetherboundInstallCheck'
$expectedRoot = [System.IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
if (-not ([System.IO.Path]::GetFullPath($installDir) + '\').StartsWith($expectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Installation target must stay under RUNNER_TEMP.'
}

$profileDir = Join-Path $env:APPDATA 'Aetherbound'
New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
$sentinel = Join-Path $profileDir 'installer-preserve-data-check.txt'
Set-Content -LiteralPath $sentinel -Value 'Keep user data on uninstall.'

$install = Start-Process -FilePath $installerPath -ArgumentList '/S', "/D=$installDir" -WindowStyle Hidden -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "Installer exited with $($install.ExitCode)." }

$executable = Join-Path $installDir 'Aetherbound.exe'
if (-not (Test-Path -LiteralPath $executable)) { throw 'Installed executable is missing.' }
$env:READER_E2E_EXECUTABLE = $executable
pnpm test:e2e:release
if ($LASTEXITCODE -ne 0) { throw 'Installed application smoke test failed.' }

$uninstaller = Get-ChildItem -LiteralPath $installDir -Filter '*uninstall*.exe' -File | Select-Object -First 1
if (-not $uninstaller) { throw 'Uninstaller is missing.' }
$uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited with $($uninstall.ExitCode)." }
if (-not (Test-Path -LiteralPath $sentinel)) { throw 'Uninstall removed user data.' }
Write-Output 'Installer, installed app, uninstaller, and user-data retention verified.'
