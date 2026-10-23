# No real network, autostart, bridge processes or personal state. Network edges
# are deterministic stubs; target writers, DPAPI, start/stop and revision gates
# below are the production functions/scripts.
param([string]$EvidenceDirectory = '')
$ErrorActionPreference = 'Stop'
$app = Split-Path $PSScriptRoot -Parent
. (Join-Path $app 'common.ps1')
. (Join-Path $app 'manager-targets.ps1')
$temp = Join-Path ([IO.Path]::GetTempPath()) ('cmcp-inline-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($temp)
$script:StateDir=$temp
$script:TargetsFile=Join-Path $temp 'cloudpc-targets.json'
$script:StatusFile=Join-Path $temp 'link-status.json'
$script:StopFlag=Join-Path $temp 'stopped.flag'
$script:ErrorLog=Join-Path $temp 'error.log'
$checks=New-Object Collections.Generic.List[string]
$events=New-Object Collections.Generic.List[object]
function Check([bool]$Ok,[string]$Name){if(!$Ok){throw $Name};$checks.Add($Name)}
function Rejected([scriptblock]$Body){try{& $Body | Out-Null;return $false}catch{return $true}}
function Read-Snapshot([string]$Path){
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    $reader=New-Object IO.StreamReader($stream,[Text.Encoding]::UTF8)
    try{return $reader.ReadToEnd()}finally{$reader.Dispose()}
}
function Load-Function([string]$File,[string]$Name){
    $ast=[Management.Automation.Language.Parser]::ParseFile($File,[ref]$null,[ref]$null)
    $definition=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $Name},$true)
    if(!$definition){throw 'Missing production function'}
    return [scriptblock]::Create($definition.Extent.Text)
}
. (Load-Function (Join-Path $app 'manager-save.ps1') 'Invoke-ManagerSave')
function Send-ManagerEvent($Kind,$Message,$Name=''){$events.Add(@{kind=$Kind;message=$Message;name=$Name})}
function Test-CloudAddress {return @{Ok=$script:health}}
function Get-CloudAuthMode {return $script:mode}
function Test-CloudLogin {return @{Ok=$script:login;Kind='password'}}
$script:health=$true;$script:mode='shared-browser';$script:login=$true
$children=New-Object Collections.Generic.List[object]
$created=New-Object Collections.Generic.List[string]
try {
    Save-CloudTarget 'A' 'https://a.invalid' '' 'shared-browser'
    Save-CloudTarget 'B' 'https://b.invalid' '' 'shared-browser'
    $null=Set-TargetConnection 'B' $true
    $switches=[IO.File]::ReadAllText((Join-Path $temp 'target-controls.json'))
    Check (Invoke-ManagerSave @{action='add';url='https://new.invalid';password='MUSTNOTSTORE'}) 'embedded add executes production save after safe protocol check'
    $new=@(Get-CloudTargets | Where-Object url -eq 'https://new.invalid')[0]
    Check ($new.authMode -eq 'shared-browser' -and !$new.password) 'shared browser add discards entered password'
    Check ([IO.File]::ReadAllText((Join-Path $temp 'target-controls.json')) -ceq $switches) 'adding does not enable any target or change B switches'
    Check (Rejected {Invoke-ManagerSave @{action='add';url='https://b.invalid'}}) 'duplicate add refuses to overwrite B'
    $before=[IO.File]::ReadAllText($TargetsFile)
    $script:health=$false
    Check (!(Invoke-ManagerSave @{action='edit';name='A';url='https://other.invalid'})) 'failed health check returns inline failure'
    Check ([IO.File]::ReadAllText($TargetsFile) -ceq $before) 'failed validation preserves saved target bytes'
    $script:health=$true;$script:mode='legacy'
    Check (!(Invoke-ManagerSave @{action='add';url='https://old.invalid'})) 'legacy target requires password without a credential dialog'
    $script:login=$false
    Check (!(Invoke-ManagerSave @{action='add';url='https://old.invalid';password='TESTONLY123'})) 'failed legacy login never saves credentials'
    $script:login=$true
    Check (Invoke-ManagerSave @{action='add';url='https://old.invalid';password='TESTONLY123'}) 'legacy authentication success uses production DPAPI writer'
    $cipher=@(Get-CloudTargets | Where-Object url -eq 'https://old.invalid')[0].password
    Check ($cipher -ne 'TESTONLY123' -and (Unprotect-Text $cipher) -eq 'TESTONLY123') 'legacy credential is current account encrypted'
    Check (($events | ConvertTo-Json -Depth 4) -notmatch 'TESTONLY123|MUSTNOTSTORE') 'progress protocol never emits submitted passwords'
    $script:mode='unknown'
    Check (Rejected {Invoke-ManagerSave @{action='add';url='https://unknown.invalid';password='TESTONLY123'}}) 'unknown protocol refuses password and save'
    Check (Rejected {Invoke-ManagerSave @{action='add';url='https://user:secret@a.invalid'}}) 'worker rejects credential bearing URL independently of UI'
    Check (Rejected {Invoke-ManagerSave @{action='edit';name='B';url='https://changed.invalid'}}) 'worker cannot edit enabled B'
    $script:mode='shared-browser'

    # Start the actual selected-target scripts in a private fixture directory.
    $fixture=Join-Path (Split-Path $app -Parent) ('build-results\inline-fixture-' + [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($fixture)
    foreach($file in @('start.ps1','stop.ps1','manager-open.ps1','manager-events.ps1','cloud-api.ps1')){Copy-Item -LiteralPath (Join-Path $app $file) -Destination (Join-Path $fixture $file)}
    $source=[IO.File]::ReadAllText((Join-Path $app 'start.ps1'))
    $required=[regex]::Match($source,"foreach \(\`$f in @\(([^\r\n]+)\)\)").Groups[1].Value
    foreach($match in [regex]::Matches($required,"'([^']+)'")){
        $file=Join-Path $fixture $match.Groups[1].Value
        if(Test-Path -LiteralPath $file){continue}
        [void][IO.Directory]::CreateDirectory((Split-Path $file -Parent));[IO.File]::WriteAllText($file,'');$created.Add($file)
    }
    # ui.ps1 intentionally throws if any modal/progress UI is reached.
    [IO.File]::WriteAllText((Join-Path $fixture 'ui.ps1'),"function Open-ProgressWindow { throw 'POPUP' }; function Show-Info { throw 'POPUP' }; function Show-Error { throw 'POPUP' }; function Show-CredentialDialog { throw 'POPUP' }",[Text.UTF8Encoding]::new($true))
    $common=". '" + (Join-Path $app 'common.ps1').Replace("'","''") + "'`n" + @'
$script:KitDir=$PSScriptRoot
$script:StateDir='TEST_STATE_DIRECTORY'
$script:TargetsFile=Join-Path $StateDir 'cloudpc-targets.json'
$script:StatusFile=Join-Path $StateDir 'link-status.json'
$script:StopFlag=Join-Path $StateDir 'stopped.flag'
$script:ErrorLog=Join-Path $StateDir 'error.log'
function Initialize-StateDir {}
function Unblock-Kit {}
function Get-NodeExe { return 'fixture-node.exe' }
function Invoke-Quiet { return @{Output='v22.23.3';Code=0} }
function Invoke-Capture {
    [IO.File]::WriteAllText((Join-Path $StateDir 'selftest-started'),'1')
    while(!(Test-Path -LiteralPath (Join-Path $StateDir 'allow-init'))){Start-Sleep -Milliseconds 50}
    return @{Out='SELFTEST-OK';Err='';Code=0;TimedOut=$false}
}
function Get-LocalConfig {return @{roots=@('TEST-ONLY')}}
function Resolve-NodeArgs {return @()}
function Register-AutoStart {[IO.File]::WriteAllText((Join-Path $StateDir 'autostart-reached'),'1');return 'fixture'}
function Start-LinkService {[IO.File]::WriteAllText((Join-Path $StateDir 'backend-started'),'1')}
function Stop-LinkService {throw 'GLOBAL STOP FORBIDDEN'}
function Unregister-AutoStart {throw 'GLOBAL STOP FORBIDDEN'}
function Open-SharedCloudBrowser {return $false}
function Get-LinkStatus {
    $map=@{}
    foreach($c in @((Get-TargetControls).targets)){$map[$c.name]=@{state=$(if($c.enabled){'waiting-login'}else{'stopped'});revision=$c.revision;message='DO-NOT-FORWARD-RAW-BACKEND'}}
    return @{controlProtocol=1;pid=TEST_PID;targets=$map}
}
'@
    $common=$common.Replace('TEST_PID',[string]$PID).Replace('TEST_STATE_DIRECTORY',$temp.Replace("'","''"))
    [IO.File]::WriteAllText((Join-Path $fixture 'common.ps1'),$common,[Text.UTF8Encoding]::new($true))
    $ps=Join-Path $PSHOME 'powershell.exe'
    function Spawn([string]$File,[long]$Time,[string]$Log){
        $args='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $fixture $File)+'" -TargetName A -ManagerMode'
        if($Time){$args+=' -RequestTime '+$Time}
        $child=Start-Process $ps -ArgumentList $args -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $temp ($Log+'.out')) -RedirectStandardError (Join-Path $temp ($Log+'.err'))
        $null=$child.Handle
        $children.Add($child);return $child
    }
    function WaitFile([string]$Name){$until=[DateTime]::UtcNow.AddSeconds(10);while(!(Test-Path -LiteralPath (Join-Path $temp $Name))){if([DateTime]::UtcNow -gt $until){throw ('Timed out: '+$Name)};Start-Sleep -Milliseconds 50}}
    $time=[DateTime]::UtcNow.Ticks
    $start=Spawn 'start.ps1' $time 'init'
    WaitFile 'selftest-started'
    $stop=Spawn 'stop.ps1' ($time+1000) 'cancel-init'
    Check ($stop.WaitForExit(10000) -and $stop.ExitCode -eq 0) 'actual headless stop completes while start selftest remains blocked'
    Check (!$start.HasExited) 'cancellation does not wait for blocked initialization observer'
    [IO.File]::WriteAllText((Join-Path $temp 'allow-init'),'1')
    Check ($start.WaitForExit(10000) -and $start.ExitCode -eq 0) 'cancelled production start exits without modal or backend startup'
    Check (!(Test-Path -LiteralPath (Join-Path $temp 'backend-started')) -and !(Test-Path -LiteralPath (Join-Path $temp 'autostart-reached'))) 'late initialization cannot restart cancelled target or alter autostart'
    $a=@((Get-TargetControls).targets | Where-Object name -eq 'A')[0];$b=@((Get-TargetControls).targets | Where-Object name -eq 'B')[0]
    Check (!$a.enabled -and $b.enabled) 'cancel during initialization preserves enabled B'
    $start=Spawn 'start.ps1' ([DateTime]::UtcNow.Ticks) 'waiting'
    WaitFile 'backend-started'
    $until=[DateTime]::UtcNow.AddSeconds(10)
    do{Start-Sleep -Milliseconds 100;$out=Read-Snapshot (Join-Path $temp 'waiting.out')}while($out -notmatch '\[4/5\]' -and [DateTime]::UtcNow -lt $until)
    Check ($out -match '\[4/5\]' -and !$start.HasExited) 'actual start reaches inline waiting-login stage without popup'
    Check ($out -notmatch 'DO-NOT-FORWARD') 'raw backend messages are excluded from manager progress'
    $stop=Spawn 'stop.ps1' ([DateTime]::UtcNow.Ticks) 'cancel-wait'
    Check ($stop.WaitForExit(10000) -and $stop.ExitCode -eq 0 -and $start.WaitForExit(10000) -and $start.ExitCode -eq 0) 'waiting-login can be cancelled with production revision checks'
    Check (@((Get-TargetControls).targets | Where-Object { $_.name -eq 'B' -and $_.enabled }).Count -eq 1) 'second cancellation retains B enabled'
    $open=Spawn 'manager-open.ps1' 0 'open'
    Check ($open.WaitForExit(10000) -and $open.ExitCode -eq 1 -and [IO.File]::ReadAllText((Join-Path $temp 'open.out')) -match 'schema') 'explicit unavailable desktop open reports inline instead of modal'
    Check (!(Test-Path -LiteralPath $StopFlag)) 'all inline operations avoid global stop flag'
    [pscustomobject]@{passed=$checks.Count;failed=0;skipped=0;not_executed=@('real VPS authentication and manual visual operation');checks=@($checks)} | ConvertTo-Json -Depth 4
}catch{
    [pscustomobject]@{passed=$checks.Count;failed=1;skipped=0;error=$_.ToString();checks=@($checks);evidenceDirectory=$temp} | ConvertTo-Json -Depth 4
    exit 1
}finally{
    foreach($child in $children){try{if(!$child.HasExited){$child.Kill()};$child.Dispose()}catch{}}
    if($EvidenceDirectory){
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($EvidenceDirectory))
        foreach($name in @('init','cancel-init','waiting','cancel-wait','open')){foreach($suffix in @('.out','.err')){
            $file=Join-Path $temp ($name+$suffix)
            if(Test-Path -LiteralPath $file){Copy-Item -LiteralPath $file -Destination (Join-Path $EvidenceDirectory ($name+$suffix))}
        }}
        $file=Join-Path $temp 'error.log';if(Test-Path -LiteralPath $file){Copy-Item -LiteralPath $file -Destination (Join-Path $EvidenceDirectory 'fixture-error.log')}
    }
    # Preserve isolated evidence on disk; never recursively remove unknown data.
}
