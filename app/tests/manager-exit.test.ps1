# Real hidden exit worker against private state and an isolated Node process only.
param([string]$EvidenceDirectory='')
$ErrorActionPreference='Stop'
$app=Split-Path $PSScriptRoot -Parent
. (Join-Path $app 'common.ps1')
$node=Get-NodeExe
$temporary=Join-Path ([IO.Path]::GetTempPath()) ('cmcp-exit-'+[guid]::NewGuid().ToString('N'))
$kit=Join-Path $temporary 'kit';$state=Join-Path $temporary 'state'
[void][IO.Directory]::CreateDirectory($kit);[void][IO.Directory]::CreateDirectory($state)
if(!$EvidenceDirectory){$EvidenceDirectory=Join-Path (Split-Path $app -Parent) 'build-results\exit-worker'}
[void][IO.Directory]::CreateDirectory($EvidenceDirectory)
$checks=New-Object Collections.Generic.List[string]
function Check($ok,$name){if(!$ok){throw $name};$checks.Add($name)}
function Put([string]$file,[string]$text){[IO.File]::WriteAllText($file,$text,[Text.UTF8Encoding]::new($true))}
$common=@'
. 'REAL_COMMON'
$script:KitDir=$PSScriptRoot
$script:StateDir=Join-Path (Split-Path $PSScriptRoot -Parent) 'state'
$script:TargetsFile=Join-Path $StateDir 'cloudpc-targets.json'
$script:StatusFile=Join-Path $StateDir 'link-status.json'
$script:StopFlag=Join-Path $StateDir 'stopped.flag'
$script:ErrorLog=Join-Path $StateDir 'error.log'
function Get-ServiceProcesses {
    $server='"'+(Join-Path $KitDir 'server.mjs')+'"'
    return @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and ([string]$_.CommandLine).Contains($server) })
}
function Register-AutoStart {throw 'UNEXPECTED AUTOSTART WRITE'}
function Unregister-AutoStart {throw 'UNEXPECTED AUTOSTART WRITE'}
'@
Put (Join-Path $kit 'common.ps1') $common.Replace('REAL_COMMON',(Join-Path $app 'common.ps1').Replace("'","''"))
Copy-Item -LiteralPath (Join-Path $app 'manager-exit.ps1') -Destination $kit
$server=@'
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const state=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','state');
const publish=()=>fs.writeFileSync(path.join(state,'link-status.json'),JSON.stringify({pid:process.pid,at:new Date().toISOString(),targets:{}}));
publish();setInterval(()=>{if(fs.existsSync(path.join(state,'stopped.flag')))process.exit(0);publish();},100);
'@
Put (Join-Path $kit 'server.mjs') $server
$backend=$null;$worker=$null
try{
    Put (Join-Path $state 'cloudpc-targets.json') '[{"name":"A","url":"https://a.invalid","password":"fixture-only"},{"name":"B","url":"https://b.invalid"}]'
    Put (Join-Path $state 'target-controls.json') '{"schema":1,"targets":[{"name":"A","enabled":true,"revision":"A1"},{"name":"B","enabled":true,"revision":"B1"}]}'
    Put (Join-Path $state 'application-preferences.json') '{"schema":1,"autoStart":true,"closeAction":"tray"}'
    $targets=[IO.File]::ReadAllText((Join-Path $state 'cloudpc-targets.json'));$settings=[IO.File]::ReadAllText((Join-Path $state 'application-preferences.json'))
    $backend=Start-Process $node -ArgumentList ('"'+(Join-Path $kit 'server.mjs')+'"') -WindowStyle Hidden -PassThru
    $deadline=[DateTime]::UtcNow.AddSeconds(8)
    while(!(Test-Path -LiteralPath (Join-Path $state 'link-status.json'))){if([DateTime]::UtcNow -gt $deadline){throw 'Fixture backend failed to start'};Start-Sleep -Milliseconds 50}
    $worker=Start-Process powershell.exe -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+(Join-Path $kit 'manager-exit.ps1')+'"') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $EvidenceDirectory 'exit.out') -RedirectStandardError (Join-Path $EvidenceDirectory 'exit.err')
    $null=$worker.Handle
    if(!$worker.WaitForExit(30000)){throw 'Exit worker timed out'}
    Check ($worker.ExitCode -eq 0) 'explicit exit worker completes successfully without UI'
    Check ($backend.WaitForExit(5000)) 'exit actually stops the isolated backend process'
    $controls=Get-Content (Join-Path $state 'target-controls.json') -Raw | ConvertFrom-Json
    Check (@($controls.targets | Where-Object {$_.enabled}).Count -eq 0) 'all targets including connecting targets are disabled'
    Check (@($controls.targets | Where-Object {[long]$_.requestTime -gt 0}).Count -eq 2) 'stop-all supersedes earlier pending start requests'
    Check ((Test-Path -LiteralPath (Join-Path $state 'stopped.flag')) -and !(Test-Path -LiteralPath (Join-Path $state 'link-status.json'))) 'stop flag prevents watchdog restart and stale connected status is removed'
    Check ([IO.File]::ReadAllText((Join-Path $state 'cloudpc-targets.json')) -ceq $targets) 'saved target addresses and encrypted credentials remain untouched'
    Check ([IO.File]::ReadAllText((Join-Path $state 'application-preferences.json')) -ceq $settings) 'autostart and close preferences are preserved'
    Check ((Get-Item (Join-Path $EvidenceDirectory 'exit.out')).Length -eq 0 -and (Get-Item (Join-Path $EvidenceDirectory 'exit.err')).Length -eq 0) 'successful exit has no console or dialog output'
    [pscustomobject]@{passed=$checks.Count;failed=0;skipped=0;checks=$checks}|ConvertTo-Json
}finally{
    foreach($process in @($worker,$backend)){if($process){try{if(!$process.HasExited){$process.Kill()}}catch{};$process.Dispose()}}
    # Keep temporary fixture and evidence for review; never enumerate live CMCP services.
}
