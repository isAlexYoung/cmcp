# 由设置页或卸载程序调用，不显示窗口：断开连接、移除云电脑上的 Claude 配置、删除本机保存的设置。
# 确认和结果提示由调用方完成。退出码：0 已卸载；2 本机已清理，但有云电脑上的配置未能移除；1 未完成。
trap { exit 1 }
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'cloud-api.ps1')
. (Join-Path $PSScriptRoot 'ui.ps1')
$cloudFailed = $false
try {
    Initialize-StateDir
    Write-Utf8File $StopFlag ([DateTime]::UtcNow.ToString('o'))
    Unregister-AutoStart
    Stop-LinkService
    foreach ($t in @(Get-CloudTargets)) {
        try {
            Connect-CloudPc $t.url (Unprotect-Text $t.password)
            $info = Invoke-CloudApi '/api/sys/info?lite=1'
            $stage = [string]$info.home + '/.local/share/cloudpc-link'
            $null = Invoke-CloudCommand "bash -lc 'test -f $stage/windows-pc-files/connector.py && python3 $stage/windows-pc-files/connector.py uninstall || true'" ([string]$info.home) 60
        } catch {
            Write-ErrorLog '移除云电脑上的配置' $_
            $cloudFailed = $true
        }
    }
    Remove-Item -LiteralPath $StateDir -Recurse -Force -ErrorAction Stop
} catch {
    Write-ErrorLog '卸载' $_
    exit 1
}
if ($cloudFailed) { exit 2 }
exit 0
