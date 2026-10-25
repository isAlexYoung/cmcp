# Real manager launch only. The all-target start/stop scripts change switches
# and must not be used for this restart.
. (Join-Path $PSScriptRoot 'common.ps1')
function Restart-ManagerBackend {
    Invoke-LinkLifecycleLock {
        foreach ($file in @('run-service.ps1','server.mjs','shared-autofill.mjs','managed-target.mjs','target-connections.mjs','node_modules\express\package.json','node_modules\ws\package.json','node_modules\@modelcontextprotocol\sdk\package.json','node_modules\@modelcontextprotocol\server-filesystem\dist\index.js')) {
            if (!(Test-Path -LiteralPath (Join-Path $KitDir $file) -PathType Leaf)) { throw 'Incomplete manager package' }
        }
        if (!(Get-NodeExe)) { throw 'Missing bundled runtime' }
        if (!(Test-Path -LiteralPath $StateDir) -and $StateDir -ieq (Join-Path (Split-Path $KitDir -Parent) 'user')) {
            $legacy=Join-Path $env:LOCALAPPDATA 'ClaudeLocalMcp'
            if (Test-Path -LiteralPath $legacy) {
                Assert-PrivateStatePath $legacy
                $portable=$StateDir
                try {
                    $script:StateDir=$legacy;$script:StopFlag=Join-Path $legacy 'stopped.flag';$script:StatusFile=Join-Path $legacy 'link-status.json'
                    Stop-LinkService
                    if (@(Get-ServiceProcesses).Count) { throw 'Previous backend has not stopped' }
                } finally { $script:StateDir=$portable;$script:StopFlag=Join-Path $portable 'stopped.flag';$script:StatusFile=Join-Path $portable 'link-status.json' }
            }
        }
        Initialize-StateDir
        $null = Get-TargetControls
        $configFile = Join-Path $StateDir 'config.json'
        if (Test-Path -LiteralPath $configFile) {
            $config = Read-JsonFile $configFile
            if (!$config -or $config.token -isnot [string] -or !$config.token -or $config.port -lt 1 -or $config.port -gt 65535 -or $config.roots -isnot [array]) { throw 'Invalid existing local configuration' }
        }
        $null = Get-LocalConfig
        Stop-LinkService
        if (@(Get-ServiceProcesses).Count) { throw 'Previous backend has not stopped' }
        if (Test-Path -LiteralPath $StatusFile) { Remove-Item -LiteralPath $StatusFile -Force }
        if (Test-Path -LiteralPath $StopFlag) { Remove-Item -LiteralPath $StopFlag -Force }
        Start-LinkService
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        do {
            $status = Get-LinkStatus
            if ($status -and $status.pid -and $status.controlProtocol -eq 1 -and $status.autoLoginProtocol -eq 1) {
                $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$status.pid) -ErrorAction SilentlyContinue
                $expected = [IO.Path]::GetFullPath((Join-Path $KitDir 'server.mjs'))
                if ($process -and $process.Name -ieq 'node.exe' -and ([string]$process.CommandLine).Contains('"' + $expected + '"')) {
                    $pending=Join-Path $StateDir 'update-cleanup.json'
                    if(Test-Path -LiteralPath $pending){try{
                        . (Join-Path $KitDir 'update-core.ps1');$cleanup=Read-JsonFile $pending
                        if($cleanup.installRoot -ine (Split-Path $KitDir -Parent)){throw 'Cleanup installation mismatch'}
                        Complete-CmcpUpdate $cleanup.installRoot $cleanup.backup $cleanup.transaction
                        Remove-Item -LiteralPath $pending
                    }catch{}}
                    return
                }
            }
            Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $deadline)
        throw 'New backend readiness was not confirmed'
    }
}
try { Restart-ManagerBackend; exit 0 }
catch {
    $safe = [Management.Automation.ErrorRecord]::new([Exception]::new('后台静默重启未能完成，请检查便携包完整性及本机进程权限。'),'ManagerRestartFailed','NotSpecified',$null)
    Write-ErrorLog '管理界面启动后台' $safe
    exit 1
}
