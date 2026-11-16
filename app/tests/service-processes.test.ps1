$ErrorActionPreference='Stop'
$app=Split-Path $PSScriptRoot -Parent
. (Join-Path $app 'common.ps1')
function Get-CimInstance { throw 'Process discovery must not use WMI' }
$folder=Join-Path ([IO.Path]::GetTempPath()) ('cmcp-native-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($folder)
$processes=@();$descendant=$null;$checks=0
function Check($ok,$message){if(!$ok){throw $message};$script:checks++;Write-Output ('PASS '+$message)}
try {
    $server=Join-Path $folder 'server.mjs';$childFile=Join-Path $folder 'child.pid'
    [IO.File]::WriteAllText((Join-Path $folder 'windows-tools.mjs'),'// fixture')
    $code="import {spawn} from 'node:child_process';import fs from 'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(process.argv[2],String(child.pid));setInterval(()=>{},1000);"
    [IO.File]::WriteAllText($server,$code)
    $backend=Start-Process (Get-NodeExe) -ArgumentList ('"'+$server+'" "'+$childFile+'"') -WindowStyle Hidden -PassThru
    $processes+=$backend
    for($i=0;$i -lt 80 -and !(Test-Path -LiteralPath $childFile);$i++){Start-Sleep -Milliseconds 50}
    Check (Test-Path -LiteralPath $childFile) 'private backend and child started'
    $descendant=Get-Process -Id ([int][IO.File]::ReadAllText($childFile))
    $fake=Start-Process (Get-NodeExe) -ArgumentList ('-e "setInterval(()=>{},1000)" "'+$server+'"') -WindowStyle Hidden -PassThru
    $processes+=$fake
    $watch=[Diagnostics.Stopwatch]::StartNew();$all=@(Get-ServiceProcesses)
    $record=$all | Where-Object {$_.ProcessId -eq $backend.Id} | Select-Object -First 1
    Check ($record -and $watch.ElapsedMilliseconds -lt 3000) 'real service discovery finishes without WMI'
    Check (!@($all | Where-Object {$_.ProcessId -eq $fake.Id}).Count) 'an entry path passed to unrelated eval code is not a CMCP service'
    $stale=$record.PSObject.Copy();$stale.CreationDate=$record.CreationDate.AddSeconds(-1)
    Stop-CmcpServiceProcess $stale
    Check (!$backend.HasExited) 'a stale creation time cannot terminate a reused PID'
    Stop-CmcpServiceProcess $record
    Check ($backend.WaitForExit(2000)) 'verified service is terminated through its handle'
    Check (!$fake.HasExited) 'an unrelated command remains alive'
    [pscustomobject]@{passed=$checks;failed=0}|ConvertTo-Json
} finally {
    foreach($process in @($processes)+@($descendant)){if($process){try{if(!$process.HasExited){$process.Kill();$null=$process.WaitForExit(1000)}}catch{};$process.Dispose()}}
    # Keep the unique fixture for review; no live installation or recursive cleanup.
}
