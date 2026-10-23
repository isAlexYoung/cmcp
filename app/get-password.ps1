# 供本机服务调用：解密指定云电脑的密码，以 Base64 输出到标准输出（只给父进程）。
param([Parameter(Mandatory)][string]$Name)
. (Join-Path $PSScriptRoot 'common.ps1')
$t = @(Get-CloudTargets | Where-Object { $_.name -eq $Name })
if (!$t.Count) { exit 3 }
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Unprotect-Text $t[0].password))))
