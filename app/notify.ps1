# 弹出一条中文提示（由本机服务在后台调用，不阻塞服务）。
param([string]$Title, [string]$Message)
. (Join-Path $PSScriptRoot 'ui.ps1')
$script:UiTitle = 'Claude 云电脑连接 - ' + $Title
[void](Show-Box $Message 'OK' 'Information')
