# Offline fixtures only. Never downloads, stops a backend or launches a real manager.
$ErrorActionPreference='Stop';. (Join-Path (Split-Path $PSScriptRoot -Parent) 'update-core.ps1')
$checks=New-Object 'Collections.Generic.List[string]'
function Check([bool]$Condition,[string]$Name){if(!$Condition){throw $Name};$checks.Add($Name)}
function Reject([scriptblock]$Action,[string]$Name){$rejected=$false;try{$null=& $Action}catch{$rejected=$true};Check $rejected $Name}
$temporary=Join-Path ([IO.Path]::GetTempPath()) ('cmcp-update-fixture-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $temporary
function Write-Tree([string]$Directory,[string]$Version){
    $null=New-Item -ItemType Directory -Path (Join-Path $Directory 'app\runtime') -Force
    $entries=@();foreach($path in @('CMCP.exe','app/runtime/node.exe','app/update.ps1','app/update-core.ps1','app/update-apply.ps1','app/manager-restart.ps1','app/package.json','docs/许可示例.txt')){
        $content='fixture '+$Version;if($path -eq 'app/package.json'){$content='{"version":"'+$Version+'"}'}
        $file=Join-Path $Directory $path.Replace('/','\');$null=New-Item -ItemType Directory -Path (Split-Path $file -Parent) -Force;[IO.File]::WriteAllText($file,$content)
        $entries+=@{path=$path;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
    }
    [IO.File]::WriteAllText((Join-Path $Directory 'app\distribution-manifest.json'),(@{schema=1;version=$Version;platform='windows-x64';files=$entries}|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
}
try{
    Check ((Get-CmcpVersion 'v4.10.0') -gt (Get-CmcpVersion '4.9.9')) 'semantic versions compare numerically'
    foreach($version in @('4.1.0-beta','4.1','4.1.0/../x','04.1.0')){Reject {Get-CmcpVersion $version} ('invalid version rejected: '+$version)}
    $name='CMCP-4.2.0-windows-x64.zip';$url='https://github.com/isAlexYoung/cmcp/releases/download/v4.2.0/'
    $release=[pscustomobject]@{draft=$false;prerelease=$false;tag_name='v4.2.0';assets=@(@{name=$name;size=100;browser_download_url=$url+$name},@{name=$name+'.sha256';size=100;browser_download_url=$url+$name+'.sha256'},@{name='CMCP-4.2.0-macos-arm64.zip';size=100;browser_download_url=$url+'mac.zip'})}
    Check ((Select-CmcpRelease $release '4.1.0').name -ceq $name) 'release selection chooses Windows x64 and ignores Mac'
    Check ($null -eq (Select-CmcpRelease $release '4.2.0')) 'same release is current'
    Check ($null -eq (Select-CmcpRelease $release '4.3.0')) 'newer installed version never downgrades'
    $release.prerelease=$true;Reject {Select-CmcpRelease $release '4.1.0'} 'prerelease excluded';$release.prerelease=$false
    $release.assets[0].browser_download_url='https://example.com/evil.zip';Reject {Select-CmcpRelease $release '4.1.0'} 'untrusted asset URL excluded';$release.assets[0].browser_download_url=$url+$name
    $release.assets=@($release.assets[1],$release.assets[2]);Reject {Select-CmcpRelease $release '4.1.0'} 'Mac-only release cannot update Windows'
    $blob=Join-Path $temporary 'checksum.zip';[IO.File]::WriteAllText($blob,'test payload');$hash=(Get-FileHash -LiteralPath $blob -Algorithm SHA256).Hash.ToLowerInvariant()
    Check ((Test-CmcpChecksum $blob ($hash+'  '+$name) $name ('sha256:'+$hash)) -ceq $hash) 'checksum and GitHub digest agree'
    Reject {Test-CmcpChecksum $blob (('0'*64)+'  '+$name) $name ''} 'corrupt bytes fail checksum'
    Reject {Test-CmcpChecksum $blob ($hash+'  wrong.zip') $name ''} 'checksum must name exact platform asset'
    Reject {Test-CmcpChecksum $blob ($hash+'  '+$name) $name ('sha256:'+('0'*64))} 'GitHub digest mismatch rejected'
    foreach($path in @('../evil','/absolute','a\b','a:stream','a/../b','a/CON.txt','a./file','a//b')){Reject {Test-CmcpRelative $path} ('unsafe path rejected: '+$path)}
    $install=Join-Path $temporary 'portable 中文';Write-Tree $install '4.1.0';Check ((Test-CmcpTree $install).version -eq '4.1.0') 'UTF8 manifest and Chinese file names validate without BOM'
    $legacy=Join-Path $temporary 'legacy';Write-Tree $legacy '4.1.0'
    Move-Item -LiteralPath (Join-Path $legacy 'CMCP.exe') -Destination (Join-Path $legacy 'Claude-MCP.exe')
    $legacyManifest=Join-Path $legacy 'app/distribution-manifest.json'
    [IO.File]::WriteAllText($legacyManifest,([IO.File]::ReadAllText($legacyManifest).Replace('CMCP.exe','Claude-MCP.exe')))
    if((Test-CmcpTree $legacy).version -ne '4.1.0' -or (Get-CmcpManagerPath $legacy) -ne (Join-Path $legacy 'Claude-MCP.exe') -or (Get-CmcpManagerPath $install) -ne (Join-Path $install 'CMCP.exe')){throw 'Manager rename compatibility failed'}
    $unknown=Join-Path $install 'personal.txt';[IO.File]::WriteAllText($unknown,'preserve');Reject {Test-CmcpTree $install} 'unknown user file prevents update';Check ((Get-Content -LiteralPath $unknown -Raw) -eq 'preserve') 'unknown user file is not changed';Remove-Item -LiteralPath $unknown
    $program=Join-Path $install 'CMCP.exe';[IO.File]::AppendAllText($program,'changed');Reject {Test-CmcpTree $install} 'modified installed code prevents update';Write-Tree $install '4.1.0'
    $git=Join-Path $install '.git';[IO.File]::WriteAllText($git,'gitdir: other');Reject {Assert-CmcpInstallRoot $install} 'git worktree source checkout is protected';Remove-Item -LiteralPath $git
    $packageRoot=Join-Path $temporary 'CMCP-4.2.0-windows-x64';Write-Tree $packageRoot '4.2.0';$zip=Join-Path $temporary 'valid.zip'
    Add-Type -AssemblyName System.IO.Compression.FileSystem,System.IO.Compression
    $archive=[IO.Compression.ZipFile]::Open($zip,[IO.Compression.ZipArchiveMode]::Create);try{foreach($item in Get-ChildItem -LiteralPath $packageRoot -File -Recurse){$relative='CMCP-4.2.0-windows-x64/'+$item.FullName.Substring($packageRoot.Length+1).Replace('\','/');$null=[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$item.FullName,$relative)}}finally{$archive.Dispose()}
    $stage=Join-Path $temporary 'new';Check ((Expand-CmcpPackage $zip $stage '4.2.0').version -eq '4.2.0') 'real ZIP extracts and verifies full file inventory'
    $badZip=Join-Path $temporary 'bad.zip';$archive=[IO.Compression.ZipFile]::Open($badZip,[IO.Compression.ZipArchiveMode]::Create);try{$null=$archive.CreateEntry('CMCP-4.2.0-windows-x64/../../escape.txt')}finally{$archive.Dispose()};$badStage=Join-Path $temporary 'bad-stage';Reject {Expand-CmcpPackage $badZip $badStage '4.2.0'} 'ZIP traversal rejected before extraction';Check (!(Test-Path -LiteralPath $badStage)) 'unsafe ZIP never creates extraction directory'
    $duplicateZip=Join-Path $temporary 'duplicate.zip';$archive=[IO.Compression.ZipFile]::Open($duplicateZip,[IO.Compression.ZipArchiveMode]::Create);try{$null=$archive.CreateEntry('CMCP-4.2.0-windows-x64/A.txt');$null=$archive.CreateEntry('CMCP-4.2.0-windows-x64/a.txt')}finally{$archive.Dispose()};Reject {Expand-CmcpPackage $duplicateZip $badStage '4.2.0'} 'case-insensitive duplicate ZIP paths rejected'
    $credentials=Join-Path $temporary 'credential-state.json';[IO.File]::WriteAllText($credentials,'CIPHER-BYTES-UNCHANGED');$credentialHash=(Get-FileHash -LiteralPath $credentials).Hash
    $backup=Join-Path $temporary 'backup';$start={param($path)return $path};$ok={param($process)return $true};$stop={param($process)}
    Check (Invoke-CmcpSwap $install $stage $backup $start $ok $stop) 'verified transaction replaces installation'
    Check ((Test-CmcpTree $install).version -eq '4.2.0' -and (Test-CmcpTree $backup).version -eq '4.1.0') 'successful update retains previous package as backup'
    $stage2=Join-Path $temporary 'new2';Write-Tree $stage2 '4.3.0';$backup2=Join-Path $temporary 'backup2';$unhealthy={param($process)return $false}
    Reject {Invoke-CmcpSwap $install $stage2 $backup2 $start $unhealthy $stop} 'failed startup triggers rollback'
    Check ((Test-CmcpTree $install).version -eq '4.2.0' -and !(Test-Path -LiteralPath $backup2)) 'rollback restores previous working package'
    Check ((Get-FileHash -LiteralPath $credentials).Hash -eq $credentialHash) 'update and rollback preserve per-user credential bytes'
    Reject {Invoke-CmcpSwap $install $stage2 $backup $start $ok $stop} 'existing backup is never overwritten'
    $cleanupError={param($process)throw 'simulated cleanup error'}
    Reject {Invoke-CmcpSwap $install $stage2 $backup2 $start $unhealthy $cleanupError} 'failed startup still attempts rollback after cleanup exception'
    Check ((Test-CmcpTree $install).version -eq '4.2.0') 'cleanup exception does not prevent restoring previous package'
    [pscustomobject]@{passed=$checks.Count;failed=0;skipped=0;checks=$checks;not_executed=@('public release download','production replacement')}|ConvertTo-Json -Depth 4
}finally{
    # This exact generated fixture root is checked before recursive cleanup.
    $resolved=[IO.Path]::GetFullPath($temporary);$parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if($resolved.StartsWith($parent,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -match '^cmcp-update-fixture-[a-f0-9]{32}$'){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
