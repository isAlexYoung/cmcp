# Local build only: no package installation, network, autostart, or VPS access.
param([string]$OutputFile = (Join-Path (Split-Path $PSScriptRoot -Parent) 'Claude-MCP.exe'))
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw '需要 Windows 自带的 .NET Framework 4.x C# 编译器。' }
$source = Join-Path $PSScriptRoot 'desktop-ui\Manager.cs'
$shortcuts = Join-Path $PSScriptRoot 'desktop-ui\Shortcuts.cs'
$shortcutTests = Join-Path $PSScriptRoot 'desktop-ui\ShortcutTests.cs'
$icon = Join-Path (Split-Path $PSScriptRoot -Parent) 'app\assets\claude-desktop.ico'
$manifest = Join-Path $PSScriptRoot 'desktop-ui\app.manifest'
$output = [IO.Path]::GetFullPath($OutputFile)
& $compiler /nologo /target:winexe /platform:anycpu /optimize+ /utf8output /codepage:65001 /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.Core.dll "/win32manifest:$manifest" "/win32icon:$icon" "/out:$output" $source $shortcuts $shortcutTests
if ($LASTEXITCODE -ne 0) { throw "编译失败，退出码 $LASTEXITCODE" }
Get-FileHash -LiteralPath $output -Algorithm SHA256 | Select-Object Path,Hash
