# 双击 Add-CloudPC.bat 运行：添加另一台云电脑，或修改已有云电脑的地址/密码（输入相同地址即为修改）。
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
    $existing = @(Get-CloudTargets)
    $intro = '请输入要添加的云电脑信息（输入已添加过的地址表示修改它的密码）：'
    if ($existing.Count) { $intro = '已添加：' + (($existing | ForEach-Object { ([Uri]$_.url).Host }) -join '、') + "`r`n" + $intro }
    $cred = Show-CredentialDialog '' $intro
    if (!$cred) { exit 0 }
    $same = @($existing | Where-Object { $_.url -eq $cred.Url })
    $name = if ($same.Count) { $same[0].name } else { Get-TargetName $cred.Url }
    while (!$same.Count -and @($existing | Where-Object { $_.name -eq $name }).Count) { $name = $name + '-2' }
    Save-CloudTarget $name $cred.Url $cred.Password $cred.AuthMode
    Show-Info "云电脑已保存。`r`n`r`n请在管理界面选中这台云电脑，再点击“启动连接”。添加地址不会自动连接其他云电脑；新版通过“打开云电脑”共用网页登录。"
    exit 0
} catch {
    Write-ErrorLog '添加云电脑' $_
    Show-Error ('保存失败：' + (Get-ChineseError $_) + "`r`n`r`n详细信息已记录到：" + $ErrorLog)
    exit 1
}
