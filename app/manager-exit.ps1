# Explicit application exit: disable every target and stop the shared backend.
# Keep the separate CMCPManager autostart preference and saved credentials.
. (Join-Path $PSScriptRoot 'common.ps1')
try {
    Initialize-StateDir
    Invoke-LinkLifecycleLock {
        $null = Set-TargetConnection '' $false -All
        Stop-LinkService
        if (@(Get-ServiceProcesses).Count) { throw 'Backend still running' }
        if (Test-Path -LiteralPath $StatusFile) { Remove-Item -LiteralPath $StatusFile -Force }
    }
    exit 0
} catch {
    $safe = [Management.Automation.ErrorRecord]::new([Exception]::new('Application exit could not confirm backend shutdown.'),'ManagerExitFailed','NotSpecified',$null)
    Write-ErrorLog 'Exit application' $safe
    exit 1
}
