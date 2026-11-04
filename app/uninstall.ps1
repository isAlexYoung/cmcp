# 由 CMCP 设置页的“卸载 CMCP”调用：断开连接、移除云电脑上的 Claude 配置、删除本机保存的设置。
# 确认由设置页或卸载程序完成。退出码：0 已卸载，1 未完成。-Headless 不显示窗口，用于静默卸载和自动化测试。-Installed 表示由卸载程序调用，程序文件由它删除。
param([switch]$Headless,[switch]$Installed)
# 窗口出来之前的任何错误也用中文提示框显示（控制台是隐藏的）
trap {
    if (!$Headless) {
        Add-Type -AssemblyName System.Windows.Forms
        [void][Windows.Forms.MessageBox]::Show("程序运行出错。请重新解压完整的压缩包后再试。`r`n`r`n如果仍然不行，请把本文件夹加入杀毒软件的信任列表。", 'CMCP', 'OK', 'Error')
    }
    exit 1
}
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'cloud-api.ps1')
. (Join-Path $PSScriptRoot 'ui.ps1')
if (!$Headless) { Open-ProgressWindow '正在卸载...' }
$ok = $true
try {
    Initialize-StateDir
    Write-Utf8File $StopFlag ([DateTime]::UtcNow.ToString('o'))
    Unregister-AutoStart
    Stop-LinkService
    Write-Ok '已断开连接，并关闭开机自动连接。'
    foreach ($t in @(Get-CloudTargets)) {
        try {
            Write-Line ('正在移除云电脑上的配置：' + $t.url)
            Connect-CloudPc $t.url (Unprotect-Text $t.password)
            $info = Invoke-CloudApi '/api/sys/info?lite=1'
            $stage = [string]$info.home + '/.local/share/cloudpc-link'
            $null = Invoke-CloudCommand "bash -lc 'test -f $stage/windows-pc-files/connector.py && python3 $stage/windows-pc-files/connector.py uninstall || true'" ([string]$info.home) 60
            Write-Ok '已移除。'
        } catch {
            Write-ErrorLog '移除云电脑上的配置' $_
            Write-Warn ('无法移除这台云电脑上的配置：' + (Get-ChineseError $_))
        }
    }
    Remove-Item -LiteralPath $StateDir -Recurse -Force -ErrorAction Stop
    Write-Ok $(if ($Installed) { '本机保存的设置已删除。' } else { '本机保存的设置已删除。现在可以删除本文件夹。' })
} catch {
    $ok = $false
    Write-ErrorLog '卸载' $_
    Write-Err ('卸载失败：' + (Get-ChineseError $_))
}
if ($ok) { Complete-ProgressWindow '卸载完成' $true; exit 0 }
Complete-ProgressWindow '卸载失败' $false
exit 1
