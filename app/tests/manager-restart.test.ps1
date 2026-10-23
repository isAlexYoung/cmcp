param([string]$EvidenceDirectory = '')
$ErrorActionPreference='Stop'
$app=Split-Path $PSScriptRoot -Parent
. (Join-Path $app 'common.ps1')
$temp=Join-Path ([IO.Path]::GetTempPath()) ('cmcp-restart-'+[Guid]::NewGuid().ToString('N'))
if(!$EvidenceDirectory){$EvidenceDirectory=Join-Path (Split-Path $app -Parent) 'build-results\restart-worker'}
[void][IO.Directory]::CreateDirectory($temp)
[void][IO.Directory]::CreateDirectory($EvidenceDirectory)
$EvidenceDirectory=[IO.Path]::GetFullPath($EvidenceDirectory)
$checks=New-Object Collections.Generic.List[string]
function Check($ok,$name){if(!$ok){throw $name};$checks.Add($name)}
function Put-File([string]$file,[string]$text){[void][IO.Directory]::CreateDirectory((Split-Path $file -Parent));[IO.File]::WriteAllText($file,$text,[Text.UTF8Encoding]::new($true))}
$kit=Join-Path $temp 'kit'
$state=Join-Path $temp 'state'
[void][IO.Directory]::CreateDirectory($kit);[void][IO.Directory]::CreateDirectory($state)
$node=Get-NodeExe
$common=@'
. 'REAL_COMMON'
$script:KitDir=$PSScriptRoot
$script:StateDir=Join-Path (Split-Path $PSScriptRoot -Parent) 'state'
$script:TargetsFile=Join-Path $StateDir 'cloudpc-targets.json'
$script:StatusFile=Join-Path $StateDir 'link-status.json'
$script:StopFlag=Join-Path $StateDir 'stopped.flag'
$script:ErrorLog=Join-Path $StateDir 'error.log'
function Get-NodeExe {return 'REAL_NODE'}
# Only this private fixture may be stopped. Never enumerate live CMCP copies.
function Get-ServiceProcesses {
    $server='"'+(Join-Path $KitDir 'server.mjs')+'"'
    $supervisor='"'+(Join-Path $KitDir 'run-service.ps1')+'"'
    return @(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -and ([string]$_.CommandLine).Contains($server)) -or ($_.Name -eq 'powershell.exe' -and ([string]$_.CommandLine).Contains($supervisor)) })
}
function Register-AutoStart {throw 'UNEXPECTED AUTOSTART CHANGE'}
function Unregister-AutoStart {throw 'UNEXPECTED AUTOSTART CHANGE'}
'@
$common=$common.Replace('REAL_COMMON',(Join-Path $app 'common.ps1').Replace("'","''")).Replace('REAL_NODE',$node.Replace("'","''"))
Put-File (Join-Path $kit 'common.ps1') $common
Copy-Item -LiteralPath (Join-Path $app 'manager-restart.ps1') -Destination $kit
$supervisor=[IO.File]::ReadAllText((Join-Path $app 'run-service.ps1')).Replace('Local\ClaudeCloudPcLinkService',('Local\CmcpRestartFixture-'+[Guid]::NewGuid().ToString('N')))
Put-File (Join-Path $kit 'run-service.ps1') $supervisor
foreach($file in @('shared-autofill.mjs','managed-target.mjs','target-connections.mjs','node_modules\express\package.json','node_modules\ws\package.json','node_modules\@modelcontextprotocol\sdk\package.json','node_modules\@modelcontextprotocol\server-filesystem\dist\index.js')){Put-File (Join-Path $kit $file) '{}'}
$server=@'
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const state=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','state');
const controls=JSON.parse(fs.readFileSync(path.join(state,'target-controls.json'),'utf8').replace(/^\uFEFF/,''));
const targets=Object.fromEntries(controls.targets.map(t=>[t.name,{state:t.enabled?'offline':'stopped',revision:t.revision}]));
fs.appendFileSync(path.join(state,'launches.txt'),process.pid+'\n');
const publish=()=>fs.writeFileSync(path.join(state,'link-status.json'),JSON.stringify({pid:process.pid,controlProtocol:1,autoLoginProtocol:AUTO_VERSION,at:new Date().toISOString(),targets}));
publish();setInterval(()=>{if(fs.existsSync(path.join(state,'stopped.flag')))process.exit(0);publish();},100);
'@
$workers=New-Object Collections.Generic.List[object]
function Worker([string]$name){
    $p=Start-Process powershell.exe -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+(Join-Path $kit 'manager-restart.ps1')+'"') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $EvidenceDirectory ($name+'.out')) -RedirectStandardError (Join-Path $EvidenceDirectory ($name+'.err'))
    $null=$p.Handle
    $workers.Add($p);return $p
}
function Finish($p){if(!$p.WaitForExit(60000)){throw 'Restart worker timed out'};return $p.ExitCode}
function Status {return ([IO.File]::ReadAllText((Join-Path $state 'link-status.json'))|ConvertFrom-Json)}
try {
    Put-File (Join-Path $state 'config.json') '{"port":18765,"token":"fixture-only-unchanged","roots":[]}'
    Put-File (Join-Path $state 'cloudpc-targets.json') ('[{"name":"A","url":"https://a.invalid","autoLogin":true,"password":"'+(Protect-Text 'fixture secret')+'"},{"name":"B","url":"https://b.invalid"}]')
    Put-File (Join-Path $state 'target-controls.json') '{"schema":1,"targets":[{"name":"A","enabled":true,"revision":"A1"},{"name":"B","enabled":false,"revision":"B1"}]}'
    Put-File (Join-Path $state 'node-extra-args.txt') ''
    $original=@{};foreach($f in @('config.json','cloudpc-targets.json','target-controls.json')){$original[$f]=[IO.File]::ReadAllText((Join-Path $state $f))}
    Put-File (Join-Path $kit 'server.mjs') $server.Replace('AUTO_VERSION','0')
    $old=Start-Process $node -ArgumentList ('"'+(Join-Path $kit 'server.mjs')+'"') -WindowStyle Hidden -PassThru
    $workers.Add($old)
    $end=[DateTime]::UtcNow.AddSeconds(10);while(!(Test-Path (Join-Path $state 'link-status.json'))){if([DateTime]::UtcNow -gt $end){throw 'Fixture start failed'};Start-Sleep -Milliseconds 50}
    Put-File (Join-Path $kit 'server.mjs') $server.Replace('AUTO_VERSION','1')
    Check ((Finish (Worker 'upgrade')) -eq 0) 'production restart upgrades an old backend without modal UI'
    $first=Status
    Check ($first.pid -ne $old.Id -and $first.autoLoginProtocol -eq 1 -and !(Get-Process -Id $old.Id -ErrorAction SilentlyContinue)) 'old node exits and a new compatible PID is confirmed'
    foreach($f in @('config.json','cloudpc-targets.json','target-controls.json')){Check ([IO.File]::ReadAllText((Join-Path $state $f)) -ceq $original[$f]) ('restart preserves exact '+$f+' bytes')}
    Check ($first.targets.A.state -eq 'offline' -and $first.targets.B.state -eq 'stopped') 'only previously enabled A resumes; B remains stopped'
    $p=Worker 'repeat';Check ((Finish $p) -eq 0 -and (Status).pid -ne $first.pid) 'every subsequent launch restarts even an already compatible backend'
    $parallel1=Worker 'parallel-1';$parallel2=Worker 'parallel-2'
    Check ((Finish $parallel1) -eq 0 -and (Finish $parallel2) -eq 0) 'simultaneous launches serialize and both complete'
    $matching=@(Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'node.exe' -and ([string]$_.CommandLine).Contains('"'+(Join-Path $kit 'server.mjs')+'"')})
    Check ($matching.Count -eq 1 -and (Get-Content (Join-Path $state 'launches.txt')).Count -eq 5) 'parallel opens leave one node instance and retain evidence of every restart'
    Check (@(Get-ChildItem $EvidenceDirectory -File | Where-Object {$_.Extension -in @('.out','.err') -and $_.Length -ne 0}).Count -eq 0) 'successful hidden workers emit no prompts or console output'
    $before=(Status).pid
    Put-File (Join-Path $state 'target-controls.json') 'corrupt'
    Check ((Finish (Worker 'corrupt')) -ne 0 -and (Get-Process -Id $before -ErrorAction SilentlyContinue)) 'corrupt controls fail before stopping the running backend'
    Put-File (Join-Path $state 'target-controls.json') $original['target-controls.json']
    Put-File (Join-Path $state 'config.json') ''
    Check ((Finish (Worker 'empty-config')) -ne 0 -and (Get-Process -Id $before -ErrorAction SilentlyContinue) -and [IO.File]::ReadAllText((Join-Path $state 'config.json')) -eq '') 'empty existing config is refused without regenerating token or stopping backend'
    Put-File (Join-Path $state 'config.json') $original['config.json']
    Remove-Item -LiteralPath (Join-Path $kit 'shared-autofill.mjs')
    Check ((Finish (Worker 'incomplete')) -ne 0 -and (Get-Process -Id $before -ErrorAction SilentlyContinue)) 'incomplete portable package fails before stopping the running backend'
    Put-File (Join-Path $kit 'shared-autofill.mjs') '{}'
    $stopped='{"schema":1,"targets":[{"name":"A","enabled":false,"revision":"A-stop"},{"name":"B","enabled":false,"revision":"B1"}]}'
    Put-File (Join-Path $state 'target-controls.json') $stopped
    Put-File (Join-Path $state 'stopped.flag') 'stop'
    Check ((Finish (Worker 'all-stopped')) -eq 0 -and (Status).targets.A.state -eq 'stopped' -and (Status).targets.B.state -eq 'stopped') 'opening after Stop All starts the backend without enabling any cloud'
    Check ([IO.File]::ReadAllText((Join-Path $state 'target-controls.json')) -ceq $stopped) 'Stop All preferences remain byte-for-byte unchanged'
    $result=@{passed=$checks.Count;failed=0;skipped=0;checks=@($checks);fixture=$temp;not_executed=@('real VPS','existing personal backend')}
    $result|ConvertTo-Json -Depth 5|Set-Content (Join-Path $EvidenceDirectory 'restart.json') -Encoding UTF8
    $result|ConvertTo-Json -Depth 5 -Compress
}catch{
    @{passed=$checks.Count;failed=1;skipped=0;checks=@($checks);error=$_.Exception.Message;fixture=$temp}|ConvertTo-Json -Depth 5|Set-Content (Join-Path $EvidenceDirectory 'restart.json') -Encoding UTF8
    throw
}finally{
    Put-File (Join-Path $state 'stopped.flag') 'stop'
    Start-Sleep -Milliseconds 200
    foreach($p in $workers){try{if(!$p.HasExited){$p.Kill()};$p.Dispose()}catch{}}
    # Identify only our uniquely named fixture, never the live CMCP backend.
    foreach($p in @(Get-CimInstance Win32_Process | Where-Object {$_.Name -in @('node.exe','powershell.exe') -and ([string]$_.CommandLine).Contains('"'+$kit+'\')})){Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue}
}
