param([string]$TargetName = '', [long]$RequestTime = 0)
# BAT without a target explicitly stops all; the manager always passes a target.
# 窗口出来之前的任何错误也用中文提示框显示（控制台是隐藏的）
trap {
    Add-Type -AssemblyName System.Windows.Forms
    [void][Windows.Forms.MessageBox]::Show("程序运行出错。请重新解压完整的压缩包后再试。`r`n`r`n如果仍然不行，请把本文件夹加入杀毒软件的信任列表。", 'Claude 云电脑连接', 'OK', 'Error')
    exit 1
}
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'ui.ps1')
try {
    Initialize-StateDir
    if ($TargetName) {
        Assert-TargetControlSupport
        $control = Set-TargetConnection $TargetName $false -RequestTime $RequestTime
        $deadline = [DateTime]::UtcNow.AddSeconds(12)
        do {
            $status = Get-LinkStatus
            if (!$status -or !$status.pid -or !(Get-Process -Id ([int]$status.pid) -ErrorAction SilentlyContinue)) { exit 0 }
            $entry = $status.targets.($TargetName)
            if ($entry -and $entry.state -eq 'stopped' -and $entry.revision -eq $control.revision) { exit 0 }
            Start-Sleep -Milliseconds 200
        } while ([DateTime]::UtcNow -lt $deadline)
        throw '此云电脑的停止开关已保存，但后台未及时确认。其他连接未被终止；请查看日志。'
    }
    # Explicit BAT stop-all also clears saved enables, so a later selected start
    # cannot bring back previously stopped targets.
    try { $null = Set-TargetConnection '' $false -All } catch { Write-ErrorLog '保存全部停止开关' $_ }
    Write-Utf8File $StopFlag ([DateTime]::UtcNow.ToString('o'))
    Unregister-AutoStart
    Stop-LinkService
    if (Test-Path -LiteralPath $StatusFile) { Remove-Item -LiteralPath $StatusFile -Force }
    Show-Info "已断开与云电脑的连接，开机自动连接也已关闭。`r`n`r`n需要重新连接时，请双击 Start-Claude-MCP.bat。"
    exit 0
} catch {
    Write-ErrorLog '断开连接' $_
    Show-Error ('断开失败：' + (Get-ChineseError $_) + "`r`n`r`n详细信息已记录到：" + $ErrorLog)
    exit 1
}
