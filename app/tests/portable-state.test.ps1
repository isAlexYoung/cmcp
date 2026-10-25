$ErrorActionPreference='Stop'
$app=Split-Path $PSScriptRoot -Parent
. (Join-Path $app 'common.ps1')
. (Join-Path $app 'update-core.ps1')
$temporary=Join-Path ([IO.Path]::GetTempPath()) ('cmcp-portable-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $temporary
$checks=New-Object Collections.Generic.List[string]
function Check($ok,$name){if(!$ok){throw $name};$checks.Add($name)}
function Reject([scriptblock]$action,$name){$failed=$false;try{& $action|Out-Null}catch{$failed=$true};Check $failed $name}
function Put($file,$text){$null=New-Item -ItemType Directory -Path (Split-Path $file -Parent) -Force;[IO.File]::WriteAllText($file,$text,[Text.UTF8Encoding]::new($false))}
try{
    $legacy=Join-Path $temporary 'legacy';$user=Join-Path $temporary 'user'
    $cipher=Protect-Text 'portable fixture secret'
    Put (Join-Path $legacy 'cloudpc-targets.json') ('[{"name":"fixture","password":"'+$cipher+'"}]')
    Put (Join-Path $legacy 'application-preferences.json') '{"schema":1,"language":"en","theme":"dark"}'
    Put (Join-Path $legacy 'control-order.txt') '999999999999999999'
    Put (Join-Path $legacy 'machine-id') 'fixture-machine'
    Put (Join-Path $legacy 'dashboard-preferences.json') '{"label":"fixture remark","icon":"fixture icon"}'
    foreach($name in @('session.json','link-status.json','browser-entries.json','stopped.flag','updates/old.zip')){Put (Join-Path $legacy $name) 'runtime only'}
    Initialize-PortableState $user $legacy
    foreach($name in @('cloudpc-targets.json','application-preferences.json','control-order.txt','machine-id','dashboard-preferences.json')){
        Check ((Get-FileHash -LiteralPath (Join-Path $legacy $name)).Hash -ceq (Get-FileHash -LiteralPath (Join-Path $user $name)).Hash) ('migration preserves exact '+$name+' bytes and retains the source')
    }
    $target=(Get-Content -LiteralPath (Join-Path $user 'cloudpc-targets.json') -Raw|ConvertFrom-Json)[0]
    Check ((Unprotect-Text $target.password) -ceq 'portable fixture secret') 'migrated DPAPI ciphertext decrypts without re-encryption'
    Check (@(Get-ChildItem -LiteralPath $user).Count -eq 5) 'stale runtime, sessions and downloads are not imported'
    Put (Join-Path $legacy 'machine-id') 'changed old data';Initialize-PortableState $user $legacy
    Check ([IO.File]::ReadAllText((Join-Path $user 'machine-id')) -ceq 'fixture-machine') 'existing portable data is never overwritten by legacy data'
    $badLegacy=Join-Path $temporary 'bad-legacy';$badUser=Join-Path $temporary 'bad-user'
    $null=New-Item -ItemType Directory -Path (Join-Path $badLegacy 'cloudpc-targets.json') -Force
    Reject {Initialize-PortableState $badUser $badLegacy} 'invalid source file aborts migration'
    Check (!(Test-Path -LiteralPath $badUser) -and @(Get-ChildItem -LiteralPath $temporary -Filter '.cmcp-user-*').Count -eq 0) 'failed migration leaves no partial user or staging folder'
    $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'update.test.ps1'),[ref]$null,[ref]$null)
    $fn=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Write-Tree'},$true)
    . ([scriptblock]::Create($fn.Extent.Text))
    $install=Join-Path $temporary 'program';$stage=Join-Path $temporary 'stage';$backup=Join-Path $temporary ('.cmcp-backup-'+[guid]::NewGuid().ToString('N'))
    Write-Tree $install '4.2.1';Write-Tree $stage '4.3.0';[IO.Directory]::Move($user,(Join-Path $install 'user'))
    Check ((Test-CmcpTree $install).version -eq '4.2.1') 'installed user data is outside program integrity inventory'
    $start={param($root)Check (Test-Path -LiteralPath (Join-Path $root 'user/cloudpc-targets.json')) 'user data is present before manager starts';return $root}
    $ok={param($process)return $true};$stop={param($process)}
    $null=Invoke-CmcpSwap $install $stage $backup $start $ok $stop
    Check (!(Test-Path -LiteralPath (Join-Path $backup 'user'))) 'program backup contains no duplicate credentials'
    $next=Join-Path $temporary 'next';Write-Tree $next '4.4.0';$nextBackup=Join-Path $temporary ('.cmcp-backup-'+[guid]::NewGuid().ToString('N'))
    Reject {Invoke-CmcpSwap $install $next $nextBackup $start {return $false} $stop} 'failed new startup rolls back portable installation'
    Check ((Test-CmcpTree $install).version -eq '4.3.0' -and [IO.File]::ReadAllText((Join-Path $install 'user/machine-id')) -ceq 'fixture-machine') 'rollback preserves latest portable data and restores old program'
    $transaction=Join-Path $temporary ('.cmcp-update-'+[guid]::NewGuid().ToString('N'));Put (Join-Path $transaction 'download.zip') 'fixture'
    Complete-CmcpUpdate $install $backup $transaction
    Check (!(Test-Path -LiteralPath $transaction) -and (Test-Path -LiteralPath $backup)) 'successful cleanup deletes downloads and retains previous program'
    $transaction2=Join-Path $temporary ('.cmcp-update-'+[guid]::NewGuid().ToString('N'));Put (Join-Path $transaction2 'download.zip') 'fixture'
    $backup2=Join-Path $temporary ('.cmcp-backup-'+[guid]::NewGuid().ToString('N'));Write-Tree $backup2 '4.3.0'
    Put (Join-Path $temporary 'unrelated.zip') 'preserve'
    Complete-CmcpUpdate $install $backup2 $transaction2
    Check (!(Test-Path -LiteralPath $backup) -and (Test-Path -LiteralPath $backup2) -and (Test-Path -LiteralPath (Join-Path $temporary 'unrelated.zip'))) 'subsequent cleanup retains one recorded backup and preserves unrelated files'
    Add-Type -AssemblyName System.IO.Compression.FileSystem,System.IO.Compression
    $zip=Join-Path $temporary 'hostile.zip';$archive=[IO.Compression.ZipFile]::Open($zip,[IO.Compression.ZipArchiveMode]::Create)
    try{$null=$archive.CreateEntry('CMCP-4.3.0-windows-x64/user/cloudpc-targets.json')}finally{$archive.Dispose()}
    Reject {Expand-CmcpPackage $zip (Join-Path $temporary 'hostile-stage') '4.3.0'} 'release ZIP cannot provide or overwrite user data'
    Check (!(Test-Path -LiteralPath (Join-Path $temporary 'hostile-stage'))) 'user payload rejected before extraction'
    [pscustomobject]@{passed=$checks.Count;failed=0;skipped=0;checks=$checks}|ConvertTo-Json -Depth 4
}finally{
    $full=[IO.Path]::GetFullPath($temporary);$prefix=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if($full.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($full) -match '^cmcp-portable-[a-f0-9]{32}$'){Remove-Item -LiteralPath $full -Recurse -Force}
}
