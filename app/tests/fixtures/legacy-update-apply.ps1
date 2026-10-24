param([Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{32}$')][string]$Transaction)
$ErrorActionPreference='Stop'
$state=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ClaudeLocalMcp'
$directory=Join-Path (Join-Path $state 'updates') $Transaction
if([IO.Path]::GetFullPath($PSScriptRoot) -ine [IO.Path]::GetFullPath($directory)){exit 1}
. (Join-Path $PSScriptRoot 'update-core.ps1')
$held=$false;$canRecover=$false
$mutex=New-Object Threading.Mutex($false,'Local\CMCP-UpdateApply')
try{
    try{$held=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$held=$true};if(!$held){throw 'Another update is applying'}
    $request=Get-Content -LiteralPath (Join-Path $directory 'request.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $install=Assert-CmcpInstallRoot $request.installRoot
    $parent=[IO.Path]::GetDirectoryName($install);$stage=Join-Path $parent ('.cmcp-new-'+$Transaction);$backup=Join-Path $parent ('.cmcp-backup-'+$Transaction)
    if($request.schema -ne 1 -or $request.staged -cne $stage -or $request.backup -cne $backup -or $request.token -cnotmatch '^[a-f0-9]{32}$' -or (Get-CmcpVersion $request.version) -le (Get-CmcpVersion $request.oldVersion)){throw 'Invalid update transaction'}
    $null=Test-CmcpTree $stage $request.version
    $manager=Get-Process -Id $request.managerPid -ErrorAction SilentlyContinue
    if($manager){if($manager.Path -ine (Join-Path $install 'Claude-MCP.exe') -or $manager.StartTime.ToUniversalTime().Ticks.ToString() -cne $request.managerStart){throw 'Manager process identity changed'};if(!$manager.WaitForExit(60000)){throw 'Manager still running'}}
    $canRecover=$true
    # Stop only the known CMCP backend, preserving target enable switches and passwords.
    . (Join-Path $install 'app\common.ps1');Stop-LinkService
    if(@(Get-ServiceProcesses).Count){throw 'Backend did not stop'}
    $null=Test-CmcpTree $install $request.oldVersion
    $launch={param($root) Start-Process -FilePath (Join-Path $root 'Claude-MCP.exe') -ArgumentList @('--updated',$Transaction) -PassThru}
    $healthy={param($process) $deadline=[DateTime]::UtcNow.AddSeconds(180);while([DateTime]::UtcNow -lt $deadline){if($process.HasExited){return $false};$ready=Join-Path $directory 'ready.json';if(Test-Path -LiteralPath $ready){try{$ack=Get-Content -LiteralPath $ready -Raw -Encoding UTF8|ConvertFrom-Json;if($ack.token -ceq $request.token -and $ack.pid -eq $process.Id){return $true}}catch{}};Start-Sleep -Milliseconds 250};return $false}
    $stopFailed={param($process)try{if(!$process.HasExited){$process.Kill()}}catch{if(!$process.HasExited){throw}};$process.WaitForExit(10000)|Out-Null;Stop-LinkService}
    $null=Invoke-CmcpSwap $install $stage $backup $launch $healthy $stopFailed
    [IO.File]::WriteAllText((Join-Path $directory 'complete.txt'),'Update completed. Previous package retained at '+$backup)
}catch{
    [IO.File]::WriteAllText((Join-Path $directory 'failure.txt'),'Update could not complete. The previous package is retained; see .cmcp-backup folders if recovery is needed.')
    $oldRestored=$false
    if($canRecover){try{$oldRestored=(Test-CmcpTree $install).version -ceq $request.oldVersion}catch{}}
    if($oldRestored){
        $running=@(Get-Process -Name 'Claude-MCP' -ErrorAction SilentlyContinue | Where-Object {$_.Path -ieq (Join-Path $install 'Claude-MCP.exe')})
        if(!$running.Count){Start-Process -FilePath (Join-Path $install 'Claude-MCP.exe') -ArgumentList @('--updated',$Transaction)}
    }
    exit 1
}finally{if($held){$mutex.ReleaseMutex()};$mutex.Dispose()}
