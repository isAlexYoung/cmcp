# Build a fresh portable folder. Never copy per-user LOCALAPPDATA state.
param([string]$OutputDirectory = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'release'))
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'build-manager.ps1') | Out-Host
$projectRoot = Split-Path $PSScriptRoot -Parent
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'app\package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw '版本号格式不正确。' }
$packageName = 'CMCP-' + $version + '-windows-x64'
$destination = Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) $packageName
$zip = $destination + '.zip'
if ((Test-Path -LiteralPath $destination) -or (Test-Path -LiteralPath $zip)) { throw '输出位置已存在。请指定新的 OutputDirectory；不会覆盖或删除旧文件。' }
$required = @('Claude-MCP.exe','app\server.mjs','app\start.ps1','app\manager-open.ps1','app\target-controls.ps1','app\target-connections.mjs','app\managed-target.mjs','app\cloudpc-connector.py','app\cloudpc-relay.py','app\runtime\node.exe','app\runtime\LICENSE','app\assets\claude-desktop.ico','app\node_modules\@modelcontextprotocol\server-filesystem\dist\index.js','app\node_modules\@modelcontextprotocol\sdk\package.json','app\package-lock.json','docs\桌面版使用说明.md','docs\THIRD_PARTY_NOTICES.md','tools\desktop-ui\Manager.cs','tools\desktop-ui\Shortcuts.cs','tools\desktop-ui\ShortcutTests.cs')
$items = @('Claude-MCP.exe','app','docs','tools')
$required += @('app\manager-targets.ps1','app\remove-cloudpc.ps1','tools\desktop-ui\Dashboard.cs','tools\desktop-ui\DashboardControls.cs','tools\desktop-ui\DashboardTests.cs','tools\desktop-ui\UiPreferences.cs')
$required += @('tools\desktop-ui\TargetCard.cs','tools\desktop-ui\TargetEditorPage.cs','tools\desktop-ui\NativeFrame.cs')
$required += @('app\manager-events.ps1','app\manager-save.ps1','tools\desktop-ui\InlineWorker.cs','tools\desktop-ui\CardList.cs')
$required += @('app\shared-autofill.mjs')
foreach ($item in $required) { if (!(Test-Path -LiteralPath (Join-Path $projectRoot $item))) { throw "缺少打包文件：$item" } }
New-Item -ItemType Directory -Path $destination -Force | Out-Null
foreach ($item in $items) { Copy-Item -LiteralPath (Join-Path $projectRoot $item) -Destination $destination -Recurse }
$commit = $null
if (Get-Command git.exe -ErrorAction SilentlyContinue) {
    $top = & git.exe -C $projectRoot rev-parse --show-toplevel 2>$null
    if ($LASTEXITCODE -eq 0 -and [IO.Path]::GetFullPath([string]$top) -ieq [IO.Path]::GetFullPath($projectRoot)) {
        & git.exe -C $projectRoot diff --quiet HEAD --
        if ($LASTEXITCODE -ne 0) { throw '源码存在未提交修改；请先提交后再打包。' }
        $commit = ([string](& git.exe -C $projectRoot rev-parse HEAD)).Trim()
    }
}
$build = [ordered]@{version=$version;sourceCommit=$commit;builtAtUtc=[DateTime]::UtcNow.ToString('o');nodeSha256=(Get-FileHash -LiteralPath (Join-Path $destination 'app\runtime\node.exe') -Algorithm SHA256).Hash.ToLowerInvariant()}
[IO.File]::WriteAllText((Join-Path $destination 'app\build-info.json'),($build | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($destination, $zip, [IO.Compression.CompressionLevel]::Optimal, $true)
$hash = Get-FileHash -LiteralPath $zip -Algorithm SHA256
[IO.File]::WriteAllText($zip + '.sha256', $hash.Hash.ToLowerInvariant() + '  ' + [IO.Path]::GetFileName($zip) + [Environment]::NewLine, [Text.Encoding]::ASCII)
Get-Item -LiteralPath $zip | Select-Object FullName,Length
$hash | Select-Object Path,Hash
