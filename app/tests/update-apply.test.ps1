# Exercise the real external helper against disposable, compiled fake managers.
# The helper copy changes only its known-folder root and mutex for test isolation.
$ErrorActionPreference='Stop'
$app=Split-Path $PSScriptRoot -Parent
. (Join-Path $app 'update-core.ps1')
$temporary=Join-Path ([IO.Path]::GetTempPath()) ('cmcp-apply-fixture-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $temporary
$checks=New-Object 'Collections.Generic.List[string]'
function Check([bool]$Value,[string]$Name){if(!$Value){throw $Name};$checks.Add($Name)}
function Put-File([string]$Path,[string]$Text){$null=New-Item -ItemType Directory -Path (Split-Path $Path -Parent) -Force;[IO.File]::WriteAllText($Path,$Text,[Text.UTF8Encoding]::new($true))}
function New-Package([string]$Root,[string]$Version,[string]$State,[string]$Id,[string]$Token,[bool]$Healthy,[bool]$Legacy=$false,[string]$TransactionDirectory=''){
    $null=New-Item -ItemType Directory -Path (Join-Path $Root 'app\runtime') -Force
    $marker=Join-Path $State ($Version+'.started');$ready=if($TransactionDirectory){Join-Path $TransactionDirectory 'ready.json'}else{Join-Path (Join-Path (Join-Path $State 'updates') $Id) 'ready.json'}
    $behavior=if($Healthy){'File.WriteAllText(@"'+$ready+'", "{\"token\":\"'+$Token+'\",\"pid\":"+Process.GetCurrentProcess().Id+"}");Thread.Sleep(6000);'}else{'return 3;'}
    $source='using System;using System.IO;using System.Diagnostics;using System.Threading;class Fixture {static int Main(string[] args){Environment.CurrentDirectory=AppDomain.CurrentDomain.BaseDirectory;File.WriteAllText(@"'+$marker+'","started");'+$behavior+'return 0;}}'
    $sourceFile=Join-Path $temporary ('fixture-'+[guid]::NewGuid().ToString('N')+'.cs');Put-File $sourceFile $source
    & (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe') /nologo /target:winexe ('/out:'+(Join-Path $Root 'CMCP.exe')) $sourceFile |Out-Null
    if($LASTEXITCODE -ne 0){throw 'Fake manager compilation failed'}
    if($Legacy){
        if($Version -eq '4.1.0'){Move-Item -LiteralPath (Join-Path $Root 'CMCP.exe') -Destination (Join-Path $Root 'Claude-MCP.exe')}
        else{& (Join-Path (Split-Path $app -Parent) 'tools/build-legacy-launcher.ps1') -OutputFile (Join-Path $Root 'Claude-MCP.exe') -Version $Version}
    }
    Put-File (Join-Path $Root 'app\package.json') ('{"version":"'+$Version+'"}')
    foreach($file in @('runtime\node.exe','update.ps1','update-core.ps1','update-apply.ps1','manager-restart.ps1')){Put-File (Join-Path $Root ('app\'+$file)) 'fake, never executed'}
    if($Legacy -and $Version -eq '4.2.0'){
        $coreText=[IO.File]::ReadAllText((Join-Path $app 'update-core.ps1'))
        $coreText=$coreText.Replace('$legacyUpdates=Join-Path (Join-Path ([Environment]::GetFolderPath(''LocalApplicationData'')) ''ClaudeLocalMcp'') ''updates''',('$legacyUpdates='''+(Join-Path $State 'updates').Replace("'","''")+''''))
        Put-File (Join-Path $Root 'app/update-core.ps1') $coreText
        $finalize=[IO.File]::ReadAllText((Join-Path $app 'update-finalize.ps1'))
        $finalize=$finalize.Replace('$directory=Join-Path (Join-Path (Join-Path ([Environment]::GetFolderPath(''LocalApplicationData'')) ''ClaudeLocalMcp'') ''updates'') $Transaction',('$directory=Join-Path '''+(Join-Path $State 'updates').Replace("'","''")+''' $Transaction'))
        $finalize=$finalize.Replace('}catch{exit 1}','}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}')
        Put-File (Join-Path $Root 'app/update-finalize.ps1') $finalize
    }
    $stopMarker=(Join-Path $State 'backend-stopped').Replace("'","''")
    Put-File (Join-Path $Root 'app\common.ps1') ('function Stop-LinkService {[IO.File]::WriteAllText('''+$stopMarker+''',''fake backend only'')};function Get-ServiceProcesses {return @()}')
    $inventory=@();foreach($file in Get-ChildItem -LiteralPath $Root -File -Recurse){$inventory+=@{path=$file.FullName.Substring($Root.Length+1).Replace('\','/');sha256=(Get-FileHash -LiteralPath $file.FullName).Hash.ToLowerInvariant()}}
    Put-File (Join-Path $Root 'app\distribution-manifest.json') (@{schema=1;version=$Version;platform='windows-x64';files=$inventory}|ConvertTo-Json -Depth 4)
}
function Run-Case([string]$Name,[bool]$Healthy,[bool]$WrongPid,[bool]$Legacy=$false,[bool]$Portable=$false){
    $parent=Join-Path $temporary $Name;$state=if($Portable){Join-Path $parent 'portable\user'}else{Join-Path $parent 'state'};$null=New-Item -ItemType Directory -Path $state -Force
    $id=[guid]::NewGuid().ToString('N');$token=[guid]::NewGuid().ToString('N');$directory=Join-Path (Join-Path $state 'updates') $id;$install=Join-Path $parent 'portable';$stage=Join-Path $parent ('.cmcp-new-'+$id);$backup=Join-Path $parent ('.cmcp-backup-'+$id)
    if($Portable){$directory=Join-Path $parent ('.cmcp-update-'+$id)}
    $null=New-Item -ItemType Directory -Path $directory -Force
    $external=if($Portable){$directory}else{''}
    New-Package $install '4.1.0' $state $id $token $true $Legacy $external;New-Package $stage '4.2.0' $state $id $token $Healthy $Legacy $external
    $pidValue=2147483647;$start='0';if($WrongPid){$pidValue=$PID;$start=(Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks.ToString()}
    Put-File (Join-Path $directory 'request.json') (@{schema=1;installRoot=$install;staged=$stage;backup=$backup;version='4.2.0';oldVersion='4.1.0';managerPid=$pidValue;managerStart=$start;token=$token}|ConvertTo-Json)
    $core=if($Legacy){Join-Path $PSScriptRoot 'fixtures/legacy-update-core.ps1'}else{Join-Path $app 'update-core.ps1'}
    $apply=if($Legacy){Join-Path $PSScriptRoot 'fixtures/legacy-update-apply.ps1'}else{Join-Path $app 'update-apply.ps1'}
    Copy-Item -LiteralPath $core -Destination (Join-Path $directory 'update-core.ps1')
    $helper=Get-Content -LiteralPath $apply -Raw
    $helper=$helper.Replace('$state=Join-Path ([Environment]::GetFolderPath(''LocalApplicationData'')) ''ClaudeLocalMcp''',('$state='''+$state.Replace("'","''")+''''))
    $helper=$helper.Replace('Local\CMCP-UpdateApply',('Local\CMCP-UpdateFixture-'+$id))
    Put-File (Join-Path $directory 'update-apply.ps1') $helper
    $secret=Join-Path $state 'cloudpc-targets.json';Put-File $secret 'FAKE-CIPHER-UNCHANGED';$before=(Get-FileHash -LiteralPath $secret).Hash
    $process=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+(Join-Path $directory 'update-apply.ps1')+'"'),'-Transaction',$id) -WorkingDirectory $directory -WindowStyle Hidden -PassThru
    if(!$process.WaitForExit(20000)){$process.Kill();throw 'Fixture apply helper timed out'}
    Check ((Get-FileHash -LiteralPath $secret).Hash -eq $before) ($Name+': external helper preserves encrypted-state bytes')
    if($WrongPid){Check ($process.ExitCode -ne 0 -and !(Test-Path -LiteralPath (Join-Path $state 'backend-stopped')) -and (Test-CmcpTree $install).version -eq '4.1.0') 'reused or unrelated manager PID is rejected before stopping backend'}
    elseif($Healthy){$completed=if($Portable){!(Test-Path -LiteralPath $directory) -and (Test-Path -LiteralPath (Join-Path $state 'update-result.json'))}else{Test-Path -LiteralPath (Join-Path $directory 'complete.txt')};Check ($process.ExitCode -eq 0 -and $completed -and (Test-CmcpTree $install).version -eq '4.2.0') 'external helper replaces and starts a verified new executable';Check ((Test-CmcpTree $backup).version -eq '4.1.0') 'external helper retains previous package backup'}
    else{Check ($process.ExitCode -ne 0 -and (Test-CmcpTree $install).version -eq '4.1.0') 'external helper restores previous executable after failed startup';Check (Test-Path -LiteralPath (Join-Path $state '4.1.0.started')) 'external helper restarts the restored manager'}
    if($Legacy -and $Healthy){
        $migrated=Join-Path $install 'user/cloudpc-targets.json';Put-File $migrated 'FAKE-CIPHER-UNCHANGED'
        & (Join-Path $PSHOME 'powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $install 'app/update-finalize.ps1') -Transaction $id
        Check ($LASTEXITCODE -eq 0 -and !(Test-Path -LiteralPath $directory) -and (Test-Path -LiteralPath $backup) -and [IO.File]::ReadAllText($migrated) -ceq 'FAKE-CIPHER-UNCHANGED') 'first portable upgrade cleans legacy updater files only after acknowledgement and retains migrated data'
    }
}
try{
    Run-Case 'success 中文' $true $false
    Run-Case 'rollback' $false $false
    Run-Case 'wrong-pid' $true $true
    Run-Case 'legacy-success' $true $false $true
    Run-Case 'legacy-rollback' $false $false $true
    Run-Case 'portable-success' $true $false $false $true
    Run-Case 'portable-rollback' $false $false $false $true
    [pscustomobject]@{passed=$checks.Count;failed=0;skipped=0;checks=$checks;not_executed=@('personal installation','real backend')}|ConvertTo-Json -Depth 4
}finally{
    $prefix=[IO.Path]::GetFullPath($temporary).TrimEnd('\')+'\'
    foreach($process in Get-Process -Name 'CMCP','Claude-MCP' -ErrorAction SilentlyContinue){if($process.Path -and $process.Path.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){$process.Kill();$process.WaitForExit(10000)|Out-Null}}
    $parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if($prefix.StartsWith($parent,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($temporary) -match '^cmcp-apply-fixture-[a-f0-9]{32}$'){Remove-Item -LiteralPath $temporary -Recurse -Force}
}
