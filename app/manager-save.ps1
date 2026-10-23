# Only the embedded editor calls this worker. Secret input travels through an
# inherited stdin pipe, never argv, environment variables, progress or disk.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'manager-targets.ps1')
. (Join-Path $PSScriptRoot 'manager-events.ps1')
function Invoke-ManagerSave($request) {
    if ($request.action -notin @('add','edit')) { throw '未知保存操作。' }
    $parsed = $null
    if ($request.url -isnot [string] -or $request.url.Length -gt 300 -or ![Uri]::TryCreate($request.url,[UriKind]::Absolute,[ref]$parsed) -or $parsed.Scheme -ne 'https' -or $parsed.UserInfo -or $parsed.AbsolutePath -ne '/' -or $parsed.Query -or $parsed.Fragment) { throw '需要完整 HTTPS 根地址。' }
    if (([string]$request.password).Length -gt 256 -or ([string]$request.name).Length -gt 512) { throw '保存请求过长。' }
    if ($null -ne $request.autoLogin -and $request.autoLogin -isnot [bool]) { throw '自动登录选项无效。' }
    $auto = $request.autoLogin -eq $true
    $url = Get-NormalizedUrl ([string]$request.url)
    if ($request.action -eq 'edit') { Assert-ManagerTargetStopped ([string]$request.name) }
    Send-ManagerEvent 'progress' '正在检查云电脑地址…'
    $address = Test-CloudAddress $url
    if (!$address.Ok) { Send-ManagerEvent 'error' '地址无法通过健康检查，请确认地址、网络和访问限制。'; return $false }
    Send-ManagerEvent 'progress' '正在安全识别登录协议…'
    $mode = Get-CloudAuthMode $url
    if ($mode -notin @('legacy','shared-browser')) { throw '无法安全识别协议，未提交密码。' }
    $password = ''
    if ($auto) {
        if ($mode -ne 'shared-browser') { Send-ManagerEvent 'error' '此选项用于共享网页登录；旧版请取消勾选后保存。'; return $false }
        $password = [string]$request.password
        if (!$password -and $request.action -eq 'edit') {
            $old = @(Get-CloudTargets | Where-Object { $_.name -ceq $request.name -and $_.url -eq $url -and $_.autoLogin -eq $true -and $_.authMode -eq 'shared-browser' })
            if ($old.Count -eq 1) { try { $password = Unprotect-Text $old[0].password } catch {} }
        }
        if (!$password) { Send-ManagerEvent 'error' '请填写自动登录密码；更换地址时必须重新填写。'; return $false }
        # Saving never POSTs a shared password or replaces an active desktop.
    }
    if ($mode -eq 'legacy') {
        $password = (Get-NormalizedPassword ([string]$request.password)).Value
        if (!$password -and $request.action -eq 'edit') {
            $old = @(Get-CloudTargets | Where-Object { $_.name -ceq $request.name -and $_.url -eq $url })
            if ($old.Count -eq 1) { try { $password = Unprotect-Text $old[0].password } catch {} }
        }
        if (!$password) { Send-ManagerEvent 'error' '这台旧版云电脑需要密码，请在本页填写后重试。'; return $false }
        Send-ManagerEvent 'progress' '正在验证旧版密码…'
        $login = Test-CloudLogin $url $password
        if (!$login.Ok) { Send-ManagerEvent 'error' '旧版登录验证未通过，请检查密码和网络；未保存修改。'; return $false }
    }
    # Recheck duplicates and stopped state under the existing writer mutex.
    $savedName = Invoke-TargetStateLock {
        $existing = @(Get-CloudTargets)
        if (@($existing | Where-Object { $_.url -eq $url -and ($request.action -eq 'add' -or $_.name -cne $request.name) }).Count) { throw '该地址已添加，未覆盖其他卡片。' }
        if ($existing.Count -ge 100 -and $request.action -eq 'add') { throw '最多保存 100 台云电脑。' }
        if ($request.action -eq 'edit') {
            Update-ManagerCloudTarget ([string]$request.name) $url $password $mode $auto
            return [string]$request.name
        }
        $name = ([Uri]$url).Host.Split('.')[0] -replace '[^a-zA-Z0-9_-]', '-'
        if ($name.Length -gt 40) { $name = $name.Substring(0,40) }
        if (!$name) { $name = 'cloudpc' }
        while (@($existing | Where-Object { $_.name -eq $name }).Count) { $name += '-2' }
        Save-CloudTarget $name $url $password $mode $auto
        return $name
    }
    Send-ManagerEvent 'saved' '云电脑已保存，尚未启动连接。' $savedName
    return $true
}
try {
    [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
    $text = [Console]::ReadLine()
    if (!$text -or $text.Length -gt 8192) { throw '保存请求无效。' }
    $request = $text | ConvertFrom-Json
    Initialize-StateDir
    if (Invoke-ManagerSave $request) { exit 0 }
    exit 1
} catch {
    # Parser/transport exceptions can embed request text. Never log the secret
    # stdin body or an arbitrary exception message from credential operations.
    $safeError=[Management.Automation.ErrorRecord]::new([Exception]::new('保存未完成；请检查地址、协议、凭据及本机文件权限。'),'ManagerSaveFailed','NotSpecified',$null)
    Write-ErrorLog '管理界面保存云电脑' $safeError
    Send-ManagerEvent 'error' '保存未完成，请检查地址、重复配置和本机日志；未启动连接。'
    exit 1
}
