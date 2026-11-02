# Real backend, real process search, real delete and exit workers. Stop-LinkService ends
# every CMCP backend of this Windows account, so this only ever runs on a disposable CI VM.
param([string]$EvidenceDirectory='')
$ErrorActionPreference='Stop'
if(!$env:GITHUB_ACTIONS){throw 'This test stops every CMCP backend of the account; it runs only on CI.'}
$app=Split-Path $PSScriptRoot -Parent
if(!$EvidenceDirectory){$EvidenceDirectory=Join-Path (Split-Path $app -Parent) 'test-results\exit-real'}
[void][IO.Directory]::CreateDirectory($EvidenceDirectory)
$checks=New-Object Collections.Generic.List[string]
function Check($ok,$name){if(!$ok){throw $name};$checks.Add($name)}
function Worker([string]$Command,[int]$Seconds=150){
    # Same launch shape as the manager: hidden PowerShell with an encoded command.
    $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command))
    $process=Start-Process powershell.exe -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand '+$encoded) -WindowStyle Hidden -PassThru
    $null=$process.Handle
    if(!$process.WaitForExit($Seconds*1000)){$process.Kill();throw ('Worker timed out: '+$Command)}
    return $process.ExitCode
}
function Script([string]$Name,[string]$Arguments=''){return ('& '''+(Join-Path $app $Name).Replace("'","''")+''' '+$Arguments).Trim()}
function Run-Case([string]$Name,[bool]$Delete){
    $state=Join-Path ([IO.Path]::GetTempPath()) ('cmcp-exit-real-'+[guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($state);$env:CMCP_STATE_DIR=$state
    try{
        [IO.File]::WriteAllText((Join-Path $state 'cloudpc-targets.json'),'[{"name":"A","url":"https://a.invalid"}]',[Text.UTF8Encoding]::new($false))
        Check ((Worker (Script 'manager-restart.ps1')) -eq 0) ($Name+': real backend starts')
        $status=Get-Content -LiteralPath (Join-Path $state 'link-status.json') -Raw -Encoding UTF8|ConvertFrom-Json
        Check ($null -ne (Get-Process -Id ([int]$status.pid) -ErrorAction SilentlyContinue)) ($Name+': real backend process is alive')
        $enable='. '''+(Join-Path $app 'common.ps1').Replace("'","''")+''';$null=Set-TargetConnection ''A'' $true'
        Check ((Worker $enable) -eq 0) ($Name+': target is switched on')
        Start-Sleep -Seconds 3
        if($Delete){
            $removed=Worker (Script 'remove-cloudpc.ps1' '-TargetName ''A'' -ManagerMode') 60
            Check ($removed -eq 0) ($Name+': card is deleted while its connection is active')
            # Windows PowerShell does not enumerate an empty JSON array, so compare the text.
            $saved=[IO.File]::ReadAllText((Join-Path $state 'cloudpc-targets.json'))
            Check ($saved -match '^\s*\[\s*\]\s*$') ($Name+': deleted card leaves no saved target')
        }
        $code=Worker (Script 'manager-exit.ps1')
        $log=Join-Path $state 'error.log'
        if(Test-Path -LiteralPath $log){Copy-Item -LiteralPath $log -Destination (Join-Path $EvidenceDirectory ($Name+'-error.log'))}
        if($code -ne 0){
            $text=if(Test-Path -LiteralPath $log){[IO.File]::ReadAllText($log)}else{'no error log'}
            throw ($Name+': exit worker returned '+$code+"`n"+$text)
        }
        Check $true ($Name+': exit worker reports every connection stopped')
        $left=@(Get-CimInstance Win32_Process | Where-Object {$_.Name -ieq 'node.exe' -and ([string]$_.CommandLine).Contains('server.mjs')})
        Check ($left.Count -eq 0) ($Name+': no backend process remains')
    }finally{
        foreach($p in @(Get-CimInstance Win32_Process | Where-Object {$_.Name -ieq 'node.exe' -and ([string]$_.CommandLine).Contains('server.mjs')})){try{Stop-Process -Id $p.ProcessId -Force}catch{}}
        $env:CMCP_STATE_DIR=$null
    }
}
Run-Case 'connected' $false
Run-Case 'deleted' $true
[pscustomobject]@{passed=$checks.Count;failed=0;skipped=0;checks=$checks}|ConvertTo-Json
