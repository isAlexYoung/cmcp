# Local manager mutations reuse the existing lock and atomic target writer.
function Assert-ManagerTargetStopped([string]$Name) {
    $target = @(Get-CloudTargets | Where-Object { $_.name -ceq $Name })
    if ($target.Count -ne 1) { throw '所选云电脑已不存在，请刷新列表。' }
    $control = @((Get-TargetControls).targets | Where-Object { $_.name -ceq $Name })
    if ($control.Count -and $control[0].enabled) { throw '请先停止此云电脑的连接，再修改地址或删除配置。' }
    $status = Get-LinkStatus
    if ($status -and $status.pid -and (Get-Process -Id ([int]$status.pid) -ErrorAction SilentlyContinue)) {
        $entry = $status.targets.($Name)
        if ($entry -and $entry.state -ne 'stopped') { throw '后台尚未确认此连接已停止，请稍后重试。' }
    }
}
function Update-ManagerCloudTarget([string]$Name, [string]$Url, [string]$Password, [string]$AuthMode, [bool]$AutoLogin = $false) {
    if (!$Name) { throw '必须选择一台云电脑。' }
    $safe = Get-NormalizedUrl $Url
    if ($AuthMode -notin @('shared-browser','legacy')) { throw '登录方式无效。' }
    if ($AutoLogin -and ($AuthMode -ne 'shared-browser' -or !$Password)) { throw '共享自动登录需要保存密码。' }
    Invoke-TargetStateLock {
        Assert-ManagerTargetStopped $Name
        $targets = @(Get-CloudTargets)
        if (@($targets | Where-Object { $_.name -cne $Name -and $_.url -eq $safe }).Count) { throw '该地址已被另一张卡片使用，不会覆盖它。' }
        $cipher = if ($AuthMode -eq 'shared-browser' -and !$AutoLogin) { $null } else { Protect-Text $Password }
        $updated = @($targets | ForEach-Object {
            if ($_.name -ceq $Name) { [pscustomobject]@{ name = $Name; url = $safe; password = $cipher; authMode = $AuthMode; autoLogin = $AutoLogin; stamp = [DateTime]::UtcNow.ToString('o') } } else { $_ }
        })
        Write-TargetStateFile $script:TargetsFile (ConvertTo-Json -InputObject $updated -Depth 5)
    }
}
function Remove-ManagerCloudTarget([string]$Name) {
    if (!$Name) { throw '必须选择一台云电脑。' }
    Invoke-TargetStateLock {
        Assert-ManagerTargetStopped $Name
        $remaining = @(Get-CloudTargets | Where-Object { $_.name -cne $Name })
        # Disabled stale control entries are inert; the existing writer prunes
        # them on its next update. No other target switch is changed here.
        Write-TargetStateFile $script:TargetsFile (ConvertTo-Json -InputObject $remaining -Depth 5)
    }
}
