# Only called after the user clicks Open in the local manager.
param([string]$TargetName = '', [switch]$ManagerMode)
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'ui.ps1')
if ($ManagerMode) {
    . (Join-Path $PSScriptRoot 'manager-events.ps1')
    if (!$TargetName) { Send-ManagerEvent 'error' '必须选择一台云电脑。'; exit 1 }
}
try {
    $target = @(Get-CloudTargets | Where-Object { $_.name -eq $TargetName }) | Select-Object -First 1
    if (!$target) { Show-Info '请先添加并选择一台云电脑。'; exit 1 }
    if ($target.authMode -eq 'shared-browser') {
        if (!(Open-SharedCloudBrowser $TargetName)) {
            Show-Info '共享网页入口尚未就绪。请先点击“启动连接”，等待后台准备完成后再打开。'
            exit 1
        }
    } else {
        # Recheck the protocol through the existing read-only detector so an
        # older saved entry cannot open the exclusive desktop outside its gate.
        $mode = Get-CloudAuthMode $target.url
        if ($mode -eq 'shared-browser') {
            if (!(Open-SharedCloudBrowser $TargetName)) { Show-Info '请先点击“启动连接”，准备共享网页入口。'; exit 1 }
        } else {
            $safeUrl = Get-NormalizedUrl $target.url
            Start-Process -FilePath $safeUrl
        }
    }
} catch { Show-Error ('打开云电脑失败：' + (Get-ChineseError $_)); exit 1 }
