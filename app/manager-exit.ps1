# Explicit application exit: disable every target and stop the shared backend.
# Keep the separate CMCPManager autostart preference and saved credentials.
. (Join-Path $PSScriptRoot 'common.ps1')
function Write-ExitStage([string]$stage) {
    try {
        [void][IO.Directory]::CreateDirectory($StateDir)
        [IO.File]::AppendAllText((Join-Path $StateDir 'manager-exit.log'),([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss.fff')+' '+$stage+"`r`n"),[Text.UTF8Encoding]::new($false))
    } catch { }
}
try {
    Write-ExitStage 'begin'
    Initialize-StateDir
    # Save the stop request before waiting for SSH, so a slow channel cannot re-enable targets.
    Write-ExitStage 'saving stop switches'
    try { $null=Set-TargetConnection '' $false -All } catch { Write-ErrorLog 'Exit application: saving stop switches' $_ }
    $sshNode = Get-NodeExe
    $sshStopped = $true
    if ($sshNode -and (Test-Path -LiteralPath (Join-Path $StateDir 'ssh-mcp'))) {
        Write-ExitStage 'stopping SSH channels (15 second deadline)'
        $sshResult=Invoke-Capture $sshNode @(('"'+(Join-Path $KitDir 'ssh-terminal.mjs')+'"'),'--stop-all','--state',('"'+$StateDir+'"')) 15
        if ($sshResult.Code -ne 0) {
            $sshStopped=$false
            Write-ExitStage 'SSH stop failed or timed out; continuing backend cleanup'
        }
    }
    Write-ExitStage 'waiting for backend lifecycle lock (10 second deadline)'
    Invoke-LinkLifecycleLock {
        # A switch that cannot be saved must not keep the backend running: the user asked to exit.
        for ($try = 1; ; $try++) {
            try { $null = Set-TargetConnection '' $false -All; break }
            catch {
                if ($try -ge 3) { Write-ErrorLog 'Exit application: saving stop switches' $_; break }
                Start-Sleep -Milliseconds 500
            }
        }
        $left = @()
        Write-ExitStage 'stopping backend'
        for ($try = 1; $try -le 3; $try++) {
            try { Stop-LinkService } catch { Write-ErrorLog 'Exit application: stopping backend' $_ }
            $left = @(Get-ServiceProcesses)
            if (!$left.Count) { break }
            Start-Sleep -Seconds 1
        }
        if ($left.Count) { throw ('Backend still running: ' + (@($left | ForEach-Object { [string]$_.Name + ' ' + [string]$_.ProcessId }) -join ', ')) }
        if (Test-Path -LiteralPath $StatusFile) { Remove-Item -LiteralPath $StatusFile -Force -ErrorAction SilentlyContinue }
    } -TimeoutMilliseconds 10000
    if (!$sshStopped) { throw 'SSH MCP shutdown did not complete within its deadline; shared backend cleanup was attempted' }
    Write-ExitStage 'completed'
    exit 0
} catch {
    Write-ExitStage 'failed; see error.log'
    Write-ErrorLog 'Exit application' $_
    exit 1
}
