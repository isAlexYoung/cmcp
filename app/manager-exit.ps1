# Explicit application exit: disable every target and stop the shared backend.
# Keep the separate CMCPManager autostart preference and saved credentials.
. (Join-Path $PSScriptRoot 'common.ps1')
function Write-ExitStage([string]$stage) {
    try {
        [void][IO.Directory]::CreateDirectory($StateDir)
        [IO.File]::AppendAllText((Join-Path $StateDir 'manager-exit.log'),([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss.fff')+' '+$stage+"`r`n"),[Text.UTF8Encoding]::new($false))
    } catch { }
}
function Stop-SshMcpChannels([string]$Directory, [string]$NodeExe, [int]$TimeoutSeconds = 15) {
    $folder = Join-Path $Directory 'ssh-mcp'
    if (!(Test-Path -LiteralPath $folder -PathType Container)) { return $true }
    $files = @(Get-ChildItem -LiteralPath $folder -Filter '*.json' -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -cmatch '^[a-f0-9]{64}\.json$' })
    if (!$files.Count) { return $true }
    $active = @()
    $fallback = $false
    foreach ($item in $files) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
        $record = $null
        try { if ($item.Length -le 8192) { $record = Read-JsonFile $item.FullName } } catch { }
        if (!$record -or !$record.pid) { continue }
        $workerPid = [int]$record.pid
        if (!(Get-Process -Id $workerPid -ErrorAction SilentlyContinue)) { continue }
        $token = [string]$record.token
        if ($token -cnotmatch '^[a-f0-9]{64}$') { $fallback = $true; break }
        $key = $item.BaseName
        $pipe = $null
        try {
            $pipe = New-Object IO.Pipes.NamedPipeClientStream('.', ('cmcp-ssh-' + $key), [IO.Pipes.PipeDirection]::InOut)
            $pipe.Connect(1500)
            $payload = [Text.Encoding]::UTF8.GetBytes(('{"token":"' + $token + '","action":"stop"}' + "`n"))
            $pipe.Write($payload, 0, $payload.Length)
            $pipe.Flush()
            for ($b = $pipe.ReadByte(); $b -ge 0 -and $b -ne 10; $b = $pipe.ReadByte()) { }
            $active += [pscustomobject]@{ Pid = $workerPid; File = $item.FullName }
        } catch {
            if (Get-Process -Id $workerPid -ErrorAction SilentlyContinue) { $fallback = $true }
        } finally {
            if ($pipe) { $pipe.Dispose() }
        }
    }
    if ($fallback) {
        if (!$NodeExe) { return $false }
        $res = Invoke-Capture $NodeExe @(('"' + (Join-Path $KitDir 'ssh-terminal.mjs') + '"'), '--stop-all', '--state', ('"' + $Directory + '"')) $TimeoutSeconds
        return ($res.Code -eq 0)
    }
    if (!$active.Count) { return $true }
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $alive = @($active | Where-Object { (Test-Path -LiteralPath $_.File) -and (Get-Process -Id $_.Pid -ErrorAction SilentlyContinue) })
        if (!$alive.Count) { return $true }
        Start-Sleep -Milliseconds 40
    }
    return $false
}
try {
    Write-ExitStage 'begin'
    Initialize-StateDir
    # Save the stop request before waiting for SSH, so a slow channel cannot re-enable targets.
    Write-ExitStage 'saving stop switches'
    try { $null=Set-TargetConnection '' $false -All } catch { Write-ErrorLog 'Exit application: saving stop switches' $_ }
    # Signal the shared backend immediately so it shuts down in parallel with SSH channels.
    try { [IO.File]::WriteAllText($StopFlag, 'stop', [Text.UTF8Encoding]::new($false)) } catch { }
    $sshNode = Get-NodeExe
    $sshStopped = $true
    if (Test-Path -LiteralPath (Join-Path $StateDir 'ssh-mcp')) {
        Write-ExitStage 'stopping SSH channels (15 second deadline)'
        $sshStopped = Stop-SshMcpChannels $StateDir $sshNode 15
        if (!$sshStopped) {
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
