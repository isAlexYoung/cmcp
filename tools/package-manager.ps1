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
$required = @('CMCP.exe','app\server.mjs','app\start.ps1','app\manager-open.ps1','app\target-controls.ps1','app\target-connections.mjs','app\managed-target.mjs','app\cloudpc-connector.py','app\cloudpc-relay.py','app\runtime\node.exe','app\runtime\LICENSE','app\assets\claude-desktop.ico','app\node_modules\@modelcontextprotocol\server-filesystem\dist\index.js','app\node_modules\@modelcontextprotocol\sdk\package.json','app\package-lock.json','THIRD_PARTY_NOTICES.txt','tools\desktop-ui\Manager.cs','tools\desktop-ui\Shortcuts.cs','tools\desktop-ui\ShortcutTests.cs')
$items = @('CMCP.exe','app','docs','tools','THIRD_PARTY_NOTICES.txt')
$required += @('app\manager-targets.ps1','app\remove-cloudpc.ps1','tools\desktop-ui\Dashboard.cs','tools\desktop-ui\DashboardControls.cs','tools\desktop-ui\DashboardTests.cs','tools\desktop-ui\UiPreferences.cs')
$required += @('tools\desktop-ui\TargetCard.cs','tools\desktop-ui\TargetEditorPage.cs','tools\desktop-ui\NativeFrame.cs')
$required += @('app\manager-events.ps1','app\manager-save.ps1','tools\desktop-ui\InlineWorker.cs','tools\desktop-ui\CardList.cs')
$required += @('app\shared-autofill.mjs','app\web-recovery.mjs')
$required += @('app\manager-restart.ps1','tools\desktop-ui\BackendRestart.cs')
$required += @('app\update.ps1','app\update-core.ps1','app\update-apply.ps1','tools\desktop-ui\SettingsPage.cs','tools\desktop-ui\AppSettings.cs','tools\desktop-ui\Language.cs','tools\desktop-ui\Updater.cs','tools\desktop-ui\SettingsTests.cs')
$required += @('app\request-recovery.mjs','app\manager-exit.ps1')
$required += @('tools\desktop-ui\LocalToolTip.cs','tools\desktop-ui\ToolTipTests.cs')
$required += @('tools\build-legacy-launcher.ps1','tools\desktop-ui\LegacyLauncher.cs','tools\desktop-ui\UpdateProgress.cs','tools\desktop-ui\UpdateProgressTests.cs')
foreach ($item in $required) { if (!(Test-Path -LiteralPath (Join-Path $projectRoot $item))) { throw "缺少打包文件：$item" } }
New-Item -ItemType Directory -Path $destination -Force | Out-Null
foreach ($item in $items) { Copy-Item -LiteralPath (Join-Path $projectRoot $item) -Destination $destination -Recurse }
& (Join-Path $PSScriptRoot 'build-legacy-launcher.ps1') -OutputFile (Join-Path $destination 'Claude-MCP.exe') -Version $version
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
Add-Type -AssemblyName System.IO.Compression.FileSystem,System.IO.Compression
$inventory = @()
foreach ($file in Get-ChildItem -LiteralPath $destination -File -Recurse -Force) {
    $relative = $file.FullName.Substring($destination.Length+1).Replace('\','/')
    if ($relative -eq 'app/distribution-manifest.json') { throw 'Stale distribution manifest must not be packaged' }
    if ($file.Name -like '.env*' -or $file.Name -in @('application-preferences.json','config.json','cloudpc-targets.json','vps-targets.json','link-status.json','target-controls.json','browser-entries.json','manager-preferences.json','dashboard-preferences.json','session.json','stopped.flag') -or $file.Extension -in @('.lnk','.key','.pem','.pfx','.p12')) { throw 'Private state must not enter a distribution' }
    $inventory += [ordered]@{path=$relative;sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
}
$manifest = [ordered]@{schema=1;version=$version;platform='windows-x64';sourceCommit=$commit;files=$inventory}
[IO.File]::WriteAllText((Join-Path $destination 'app\distribution-manifest.json'),($manifest | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
. (Join-Path $projectRoot 'app\update-core.ps1')
$null = Test-CmcpTree $destination $version
$archive = [IO.Compression.ZipFile]::Open($zip,[IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in Get-ChildItem -LiteralPath $destination -File -Recurse -Force) {
        $relative = $packageName + '/' + $file.FullName.Substring($destination.Length+1).Replace('\','/')
        $null = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$file.FullName,$relative,[IO.Compression.CompressionLevel]::Optimal)
    }
} finally { $archive.Dispose() }
$hash = Get-FileHash -LiteralPath $zip -Algorithm SHA256
[IO.File]::WriteAllText($zip + '.sha256', $hash.Hash.ToLowerInvariant() + '  ' + [IO.Path]::GetFileName($zip) + [Environment]::NewLine, [Text.Encoding]::ASCII)
Get-Item -LiteralPath $zip | Select-Object FullName,Length
$hash | Select-Object Path,Hash
