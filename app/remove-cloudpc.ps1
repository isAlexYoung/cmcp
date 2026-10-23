param([Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string]$TargetName,[switch]$ManagerMode)
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'manager-targets.ps1')
. (Join-Path $PSScriptRoot 'ui.ps1')
if ($ManagerMode) { . (Join-Path $PSScriptRoot 'manager-events.ps1') }
try {
    if (!@(Get-CloudTargets | Where-Object { $_.name -ceq $TargetName }).Count) { throw '所选云电脑已不存在。' }
    # Use the established selected stop entry, never the global BAT.
    $command = '& ' + "'" + (Join-Path $PSScriptRoot 'stop.ps1').Replace("'", "''") + "' -TargetName '" + $TargetName.Replace("'", "''") + "'"
    if ($ManagerMode) { $command += ' -ManagerMode' }
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $exe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $child = Start-Process -FilePath $exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ' + $encoded) -WindowStyle Hidden -PassThru
    try {
        if (!$child.WaitForExit(30000)) { throw '停止向导尚未完成，未删除配置。请完成向导后重试。' }
        if ($child.ExitCode -ne 0) { throw '未确认此连接已停止，保留原配置。' }
    } finally { $child.Dispose() }
    Remove-ManagerCloudTarget $TargetName
    exit 0
} catch { Show-Error ('删除未完成：' + (Get-ChineseError $_)); exit 1 }
