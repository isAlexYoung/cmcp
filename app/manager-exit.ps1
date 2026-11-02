# Explicit application exit: disable every target and stop the shared backend.
# Keep the separate CMCPManager autostart preference and saved credentials.
. (Join-Path $PSScriptRoot 'common.ps1')
try {
    Initialize-StateDir
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
        for ($try = 1; $try -le 3; $try++) {
            try { Stop-LinkService } catch { Write-ErrorLog 'Exit application: stopping backend' $_ }
            $left = @(Get-ServiceProcesses)
            if (!$left.Count) { break }
            Start-Sleep -Seconds 1
        }
        if ($left.Count) { throw ('Backend still running: ' + (@($left | ForEach-Object { [string]$_.Name + ' ' + [string]$_.ProcessId }) -join ', ')) }
        if (Test-Path -LiteralPath $StatusFile) { Remove-Item -LiteralPath $StatusFile -Force -ErrorAction SilentlyContinue }
    }
    exit 0
} catch {
    Write-ErrorLog 'Exit application' $_
    exit 1
}
