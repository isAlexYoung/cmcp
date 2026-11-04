# Build the guided Windows installer from the portable folder package-manager.ps1 left behind.
param([Parameter(Mandatory=$true)][string]$PackageDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'app\package.json') -Raw | ConvertFrom-Json).version
$output = [IO.Path]::GetFullPath($PackageDirectory)
$source = Join-Path $output ('CMCP-' + $version + '-windows-x64')
. (Join-Path $projectRoot 'app\update-core.ps1')
$null = Test-CmcpTree $source $version
$compiler = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Inno Setup 6 is required to build the installer.' }
$setup = Join-Path $output ('CMCP-' + $version + '-windows-x64-setup.exe')
if (Test-Path -LiteralPath $setup) { throw 'The installer already exists; choose a new output directory.' }
& $compiler '/Q' ('/DAppVersion=' + $version) ('/DSourceDir=' + $source) ('/O' + $output) (Join-Path $PSScriptRoot 'installer\cmcp.iss')
if ($LASTEXITCODE -ne 0) { throw 'Installer build failed.' }
if (!(Test-Path -LiteralPath $setup)) { throw 'Installer output is missing.' }
$hash = Get-FileHash -LiteralPath $setup -Algorithm SHA256
[IO.File]::WriteAllText($setup + '.sha256', $hash.Hash.ToLowerInvariant() + '  ' + [IO.Path]::GetFileName($setup) + [Environment]::NewLine, [Text.Encoding]::ASCII)
Get-Item -LiteralPath $setup | Select-Object FullName,Length
