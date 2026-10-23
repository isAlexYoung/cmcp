# 供本机服务调用：查询 Windows 访问指定地址时使用的网络设置（与浏览器、PowerShell 相同），
# 输出形如 http://127.0.0.1:7890 的地址；直接连接时不输出任何内容。
param([Parameter(Mandatory)][string]$Url)
$ErrorActionPreference = 'Stop'
try {
    foreach ($name in @('HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($value -and $value -match '^https?://') { [Console]::Out.Write($value.TrimEnd('/')); exit 0 }
    }
    $uri = [Uri]$Url
    $system = [Net.WebRequest]::GetSystemWebProxy()
    if ($system.IsBypassed($uri)) { exit 0 }
    $proxy = $system.GetProxy($uri)
    if ($proxy -and $proxy.Host -ne $uri.Host -and $proxy.Scheme -in @('http', 'https')) {
        [Console]::Out.Write(($proxy.Scheme + '://' + $proxy.Authority))
    }
    exit 0
} catch {
    exit 0
}
