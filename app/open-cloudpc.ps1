. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'ui.ps1')
try {
    if (!(Open-SharedCloudBrowser)) {
        Show-Info '共享网页入口尚未就绪。请先运行 Start-CMCP.bat；看到“等待网页登录”后，再运行 Open-CloudPC.bat。'
    }
} catch {
    Show-Error ('打开云电脑失败：' + (Get-ChineseError $_))
}
