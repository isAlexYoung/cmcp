# Real uninstall script with its real backend stop. Stop-LinkService ends every CMCP backend
# of this Windows account, so this only ever runs on a disposable CI VM.
$ErrorActionPreference='Stop'
if(!$env:GITHUB_ACTIONS){throw 'This test stops every CMCP backend of the account; it runs only on CI.'}
$app=Split-Path $PSScriptRoot -Parent
$checks=New-Object Collections.Generic.List[string]
function Check($ok,$name){if(!$ok){throw $name};$checks.Add($name)}
function Run-Uninstall{
    $command='& '''+(Join-Path $app 'uninstall.ps1').Replace("'","''")+''''
    $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $process=Start-Process powershell.exe -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -WindowStyle Hidden -EncodedCommand '+$encoded) -WindowStyle Hidden -PassThru
    $null=$process.Handle
    if(!$process.WaitForExit(120000)){$process.Kill();throw 'Uninstall timed out'}
    return $process.ExitCode
}
function New-State{
    $state=Join-Path ([IO.Path]::GetTempPath()) ('cmcp-uninstall-'+[guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($state);$env:CMCP_STATE_DIR=$state
    # The address cannot resolve, so the remote cleanup fails and must not stop the local one.
    [IO.File]::WriteAllText((Join-Path $state 'cloudpc-targets.json'),'[{"name":"A","url":"https://a.invalid"}]',[Text.UTF8Encoding]::new($false))
    return $state
}
$state=New-State
Check ((Get-Content -LiteralPath (Join-Path $app 'uninstall.ps1') -Raw) -notmatch 'ProgressWindow|MessageBox|Windows\.Forms') 'uninstall opens no window of its own'
Check ((Run-Uninstall) -eq 2) 'an unreachable cloud PC is reported without stopping the local cleanup'
Check (!(Test-Path -LiteralPath $state)) 'the state folder is deleted'
$state=New-State
$held=[IO.File]::Open((Join-Path $state 'held.txt'),[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None)
try{
    Check ((Run-Uninstall) -eq 1) 'a file that cannot be deleted reports failure instead of success'
    Check (Test-Path -LiteralPath (Join-Path $state 'held.txt')) 'the failure leaves the held file in place'
}finally{$held.Dispose();Remove-Item -LiteralPath $state -Recurse -Force -ErrorAction SilentlyContinue;Remove-Item Env:\CMCP_STATE_DIR}
[ordered]@{passed=$checks.Count;failed=0;skipped=0;checks=$checks}|ConvertTo-Json
