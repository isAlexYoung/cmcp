# 供本机服务调用：查询 Windows 访问指定地址时使用的网络设置（与浏览器、PowerShell 相同），
# 输出形如 http://127.0.0.1:7890 的地址；直接连接时不输出任何内容。
param([Parameter(Mandatory)][string]$Url)
$ErrorActionPreference = 'Stop'
try {
    . (Join-Path $PSScriptRoot 'network-settings.ps1')
    [Console]::Out.Write((Get-CmcpProxyUrl $Url))
    exit 0
} catch {
    [Console]::Error.WriteLine('Cannot resolve CMCP proxy policy; check Settings > Connection.')
    exit 1
}
