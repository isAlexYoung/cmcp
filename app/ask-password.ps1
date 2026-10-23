# 云电脑密码被修改后，本机服务调用这个窗口让用户重新输入。
# 退出码：0 = 新密码已验证并保存，2 = 用户取消，3 = 找不到这台云电脑的设置
param([Parameter(Mandatory)][string]$Name, [string]$Reason = '')
# 窗口出来之前的任何错误也用中文提示框显示（控制台是隐藏的）
trap {
    Add-Type -AssemblyName System.Windows.Forms
    [void][Windows.Forms.MessageBox]::Show("程序运行出错。请重新解压完整的压缩包后再试。`r`n`r`n如果仍然不行，请把本文件夹加入杀毒软件的信任列表。", 'Claude 云电脑连接', 'OK', 'Error')
    exit 1
}
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'ui.ps1')
try {
    $target = @(Get-CloudTargets | Where-Object { $_.name -eq $Name })
    if (!$target.Count) { exit 3 }
    $cred = Show-CredentialDialog $target[0].url '云电脑的连接密码可能已被修改，自动连接已暂停。请输入新的连接密码：'
    if (!$cred) { exit 2 }
    Save-CloudTarget $target[0].name $cred.Url $cred.Password $cred.AuthMode
    exit 0
} catch {
    Write-ErrorLog '重新输入云电脑密码' $_
    Show-Error ('保存密码失败：' + (Get-ChineseError $_))
    exit 2
}
