param([string]$TargetName = '', [long]$RequestTime = 0, [switch]$ManagerMode)
# BAT without a target explicitly starts all; the manager always passes a target.
# 窗口出来之前的任何错误也用中文提示框显示（控制台是隐藏的）
trap {
    if ($ManagerMode) { [Console]::Error.WriteLine('Manager worker failed.'); exit 1 }
    Add-Type -AssemblyName System.Windows.Forms
    [void][Windows.Forms.MessageBox]::Show("程序运行出错。请重新解压完整的压缩包后再试。`r`n`r`n如果仍然不行，请把本文件夹加入杀毒软件的信任列表。", 'Claude 云电脑连接', 'OK', 'Error')
    exit 1
}
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'cloud-api.ps1')
. (Join-Path $PSScriptRoot 'ui.ps1')
if ($ManagerMode) {
    . (Join-Path $PSScriptRoot 'manager-events.ps1')
    if (!$TargetName) { Send-ManagerEvent 'error' '必须选择一台云电脑。'; exit 1 }
}
$script:Step = '准备启动'

function Test-Environment {
    $script:Step = '检查运行环境'
    Write-Step '[1/5] 正在检查运行环境...'
    if ($KitDir -match '\\AppData\\Local\\Temp\\' -or $KitDir -match '\.zip\\') {
        throw '请先把压缩包完整解压到一个固定文件夹（例如 D:\Claude-MCP），再双击运行。不要在压缩包里直接运行。'
    }
    $os = [Environment]::OSVersion.Version
    if ($os.Major -lt 10) { throw '需要 Windows 10 或更新版本。' }
    if ($PSVersionTable.PSVersion -lt [Version]'5.1') { throw '需要 Windows PowerShell 5.1（Windows 10 自带）。' }
    if (![Environment]::Is64BitOperatingSystem) { throw '需要 64 位 Windows。' }
    Unblock-Kit
    $node = Get-NodeExe
    if (!$node) { throw '安装包不完整：缺少 runtime\node.exe。请重新解压完整的压缩包。' }
    $ver = (Invoke-Quiet $node @('-v')).Output.Trim()
    if ($ver -notmatch '^v\d+\.') { throw '内置运行环境无法启动，可能被杀毒软件拦截。请把本文件夹加入杀毒软件的信任列表后重试。' }
    foreach ($f in @('node_modules\@modelcontextprotocol\server-filesystem\dist\index.js', 'node_modules\@modelcontextprotocol\sdk\package.json', 'node_modules\express\package.json', 'node_modules\ws\package.json', 'server.mjs', 'desktop-auth.mjs', 'shared-session-gateway.mjs', 'shared-autofill.mjs', 'cloud-connector.mjs', 'detect-auth.mjs', 'link-client.mjs', 'terminal-link.mjs', 'cloudpc-relay.py', 'cloudpc-connector.py', 'target-controls.ps1', 'target-connections.mjs', 'managed-target.mjs')) {
        if (!(Test-Path -LiteralPath (Join-Path $KitDir $f))) { throw "安装包不完整：缺少 $f。请重新解压完整的压缩包。" }
    }
    Write-Ok ('运行环境正常（Windows ' + $os.Major + '.' + $os.Build + '，内置 Node.js ' + $ver + '）')

    # 前台实测一次：真正启动本机服务的核心部分（含文件后端），把任何真实错误显示出来，
    # 不让后台服务悄悄失败。配置文件要先准备好，服务才能读取。
    $null = Get-LocalConfig
    $extra = Resolve-NodeArgs $node
    $test = Invoke-Capture $node (@($extra) + @((Join-Path $KitDir 'server.mjs'), '--selftest')) 60 $KitDir
    if ($test.Out -match 'SELFTEST-OK') {
        Write-Ok '本机服务自检通过。'
    } else {
        $detail = ($test.Err + "`n" + $test.Out).Trim()
        Write-ErrorLog '本机服务自检' ([Management.Automation.ErrorRecord]::new([Exception]::new("exit $($test.Code)`n$detail"), 'selftest', 'NotSpecified', $null))
        if ($test.TimedOut) { throw '本机服务自检超时，可能被杀毒软件拦截。请把本文件夹加入杀毒软件的信任列表后重试。' }
        $m = [regex]::Match($detail, 'SELFTEST-FAIL ([^\r\n]+)')
        if ($m.Success) { throw ('本机服务无法启动：' + $m.Groups[1].Value) }
        if ($detail -match 'bad option|not allowed|Unknown argument') { throw '内置运行环境版本不匹配，请重新解压完整的压缩包后重试。' }
        if (!$detail) { throw '本机服务无法启动，可能被杀毒软件拦截。请把本文件夹加入杀毒软件的信任列表后重试。' }
        throw ('本机服务无法启动：' + ($detail -split "`n")[0] + '  （完整信息见 ' + $ErrorLog + '）')
    }
}

function Confirm-Targets {
    $script:Step = '检查云电脑设置'
    Write-Step '[2/5] 正在检查云电脑设置...'
    $targets = @(Get-CloudTargets)
    if ($TargetName) {
        $targets = @($targets | Where-Object { $_.name -ceq $TargetName })
        if (!$targets.Count) { throw '所选云电脑已不存在，请刷新列表。' }
    }
    if (!$targets.Count) {
        Write-Line '首次使用，请在弹出的窗口中输入云电脑的地址和密码。'
        $cred = Show-CredentialDialog '' '首次使用，请输入要连接的云电脑信息：'
        if (!$cred) { throw '已取消。' }
        Save-CloudTarget (Get-TargetName $cred.Url) $cred.Url $cred.Password $cred.AuthMode
        Write-Ok '云电脑设置已保存。'
        return @(Get-CloudTargets)
    }
    foreach ($t in $targets) {
        try {
            # The background checks every protocol before logging in. Do not let
            # an unreachable saved address delay opening a new shared desktop.
            $mode = $t.authMode
            if ($mode -eq 'shared-browser') {
                if ($t.password -and $t.autoLogin -ne $true) { Save-CloudTarget $t.name $t.url '' 'shared-browser' }
                Write-Ok ('共享网页登录：' + $t.url)
                continue
            }
            $plain = $null
            try { $plain = Unprotect-Text $t.password } catch {}
            if (!$plain) {
                if ($ManagerMode) { throw '请在编辑页面更新旧版密码。' }
                $cred = Show-CredentialDialog $t.url '保存的旧版云电脑密码无法读取，请重新输入：'
                if (!$cred) { throw '已取消。' }
                Save-CloudTarget $t.name $cred.Url $cred.Password $cred.AuthMode
            }
            Write-Ok ('已读取设置，登录协议由后台只读检查：' + $t.url)
        } catch {
            if ($ManagerMode -or $_.Exception.Message -match '^已取消') { throw }
            Write-Warn ('暂时无法检查 ' + $t.url + '；后台会继续尝试，不会影响其它云电脑。')
        }
    }
    return @(Get-CloudTargets | Where-Object { !$TargetName -or $_.name -ceq $TargetName })
}

function Start-Background {
    $script:Step = '启动后台连接服务'
    Write-Step '[3/5] 正在启动后台连接服务...'
    if ($TargetName) {
        Assert-TargetControlSupport
        $latest = @((Get-TargetControls).targets | Where-Object { $_.name -ceq $TargetName } | Select-Object -First 1)
        if (!$latest.Count -or !$latest[0].enabled -or $latest[0].revision -ne $script:Control.revision) { throw '所选云电脑的启动已被停止或更改。' }
        # Reuse the shared backend; do not clear status or restart other targets.
        if (Test-Path -LiteralPath $StopFlag) { Remove-Item -LiteralPath $StopFlag -Force }
        $how = Register-AutoStart
        Start-LinkService
        Write-Ok '仅启动所选云电脑；其他连接和开关保持不变。'
        if ($how -eq 'none') { Write-Warn '无法设置开机启动；本次连接仍可继续。' }
        return
    }
    Stop-LinkService
    $null = Set-TargetConnection '' $true -All
    Remove-LegacyFiles
    $null = Get-LocalConfig
    if (Test-Path -LiteralPath $StopFlag) { Remove-Item -LiteralPath $StopFlag -Force }
    if (Test-Path -LiteralPath $StatusFile) { Remove-Item -LiteralPath $StatusFile -Force }
    $script:Step = '设置开机自动连接'
    $how = Register-AutoStart
    $script:Step = '启动后台连接服务'
    Start-LinkService
    if ($how -eq 'none') {
        Write-Warn '后台服务已启动，但开机自动连接设置失败（可能被安全软件拦截）。电脑重启后需要再次双击 Start-Claude-MCP.bat。'
    } elseif ($how -eq 'disabled') {
        Write-Ok '后台服务已启动；按设置保留开机自启关闭。'
    } else {
        Write-Ok '后台服务已启动，已设置为开机登录后自动连接。'
    }
}

function Wait-Connected($targets) {
    $script:Step = '连接云电脑'
    Write-Step '[4/5] 正在连接云电脑...'
    $begin = Get-Date
    $deadline = $begin.AddSeconds(120)
    $last = @{}
    $opened = @{}
    while ((Get-Date) -lt $deadline) {
        Wait-Ui 1000
        if ($TargetName) {
            $controls = Get-TargetControls
            $wanted = @($controls.targets | Where-Object { $_.name -ceq $TargetName } | Select-Object -First 1)
            if (!$wanted.Count -or !$wanted[0].enabled -or $wanted[0].revision -ne $script:Control.revision) { throw '所选云电脑的启动已被停止或更改。' }
        }
        $status = Get-LinkStatus
        if (!$status) {
            # 20 秒还没有状态：后台服务没有启动起来（自检已通过，所以这里多半是开机自启的隐藏进程被拦截）
            if (((Get-Date) - $begin).TotalSeconds -gt 20 -and !@(Get-ServiceProcesses | Where-Object { [string]$_.CommandLine -match '(?i)server\.mjs' }).Count) {
                $errFile = Join-Path $StateDir 'service-console.err.log'
                $tail = if (Test-Path -LiteralPath $errFile) { ((Get-Content -LiteralPath $errFile -Tail 5 -Encoding UTF8 -ErrorAction SilentlyContinue) -join ' ').Trim() } else { '' }
                throw ('后台连接服务没有启动起来，可能被杀毒软件拦截隐藏进程。请把本文件夹加入杀毒软件的信任列表后重试。' + $(if ($tail) { '  服务错误：' + $tail } else { '' }))
            }
            continue
        }
        if ($status.pid -and !(Get-Process -Id ([int]$status.pid) -ErrorAction SilentlyContinue)) {
            Write-Warn '    后台服务意外退出，正在自动重启...'
            Remove-Item -LiteralPath $StatusFile -Force -ErrorAction SilentlyContinue
            continue
        }
        $done = $true
        foreach ($t in $targets) {
            $s = $null
            if ($status.targets) { $s = $status.targets.($t.name) }
            if (!$s -or ($TargetName -and $s.revision -ne $script:Control.revision)) { $done = $false; continue }
            if ($s.state -eq 'waiting-login' -and !$opened[$t.name]) {
                if (Open-SharedCloudBrowser $t.name) { $opened[$t.name] = $true; Write-Line '已打开共享网页，请在网页中输入云电脑密码。' }
            }
            # 每一步的说明都显示出来（读取密码 → 登录 → 建立连接）
            $key = [string]$s.state + '|' + [string]$s.message
            if ($last[$t.name] -ne $key) {
                $last[$t.name] = $key
                if ($s.state -ne 'connected') { Write-Line ('    [' + $t.name + '] ' + $s.message) $(if ($s.state -in @('offline', 'error', 'url', 'locked')) { 'DarkOrange' } else { 'DimGray' }) }
            }
            switch ($s.state) {
                'connected' { }
                'password' { throw '保存的密码未通过或无法读取；自动尝试已停止。请停止此连接后编辑密码，或在共享网页手动登录。' }
                'outdated' { throw '云电脑版本过旧，不支持直连。请联系管理员更新云电脑。' }
                'replaced' { throw '另一台电脑也在连接这台云电脑。请先在那台电脑上断开。' }
                'expired' { throw $s.message }
                'notset' { throw $s.message }
                'locked' { throw $s.message }
                'url' { throw ('云电脑地址无法使用：' + $s.message) }
                default { $done = $false }
            }
        }
        if ($done) { Write-Ok '已连接到云电脑。'; return }
    }
    $lastMessage = ''
    foreach ($t in $targets) { if ($last[$t.name]) { $lastMessage = $last[$t.name].Split('|', 2)[1] } }
    if (@($targets | Where-Object { $status.targets.($_.name).state -eq 'connected' }).Count) { Write-Warn '部分云电脑尚未连接，后台将继续尝试；已连接的云电脑可以使用。'; return }
    throw ('2 分钟内没有连上云电脑' + $(if ($lastMessage) { '（' + $lastMessage + '）' } else { '' }) + '。请检查网络后重新运行；后台会继续自动重试。')
}

function Install-Connectors($targets) {
    $script:Step = '配置云电脑上的 Claude'
    Write-Step '[5/5] 正在检查云电脑上的 Claude 配置...'
    if ($ManagerMode -and (Get-LinkStatus).controlProtocol -ne 1) { throw '后台不支持逐台取消，未执行旧版配置流程。' }
    if ((Get-LinkStatus).controlProtocol -eq 1) { Write-Ok '云端配置由各自的后台连接完成，停止所选项会取消该目标的配置。'; return $false }
    $restart = $false
    foreach ($t in $targets) {
        $browserEntries = Read-JsonFile (Join-Path $StateDir 'browser-entries.json')
        if ($t.authMode -eq 'shared-browser' -or @($browserEntries.targets | Where-Object { $_.name -eq $t.name -and $_.url -eq $t.url }).Count) { Write-Ok '共享会话的 Claude MCP 配置由后台完成，无需再次登录。'; continue }
        $currentStatus = Get-LinkStatus
        if ($currentStatus.targets.($t.name).state -ne 'connected') { continue }
        Connect-CloudPc $t.url (Unprotect-Text $t.password)
        $r = Install-CloudConnector $KitDir $KitVersion
        if ($r -eq 'installed') { $restart = $true; Write-Ok 'Claude 配置已安装/更新。' } else { Write-Ok 'Claude 配置已是最新。' }
    }
    return $restart
}

Open-ProgressWindow '正在连接云电脑，请稍候...'
$lock = New-Object Threading.Mutex($false, 'Local\ClaudeCloudPcLinkStart')
$locked = $false
$success = $false
$cancelled = $false
try {
    $script:Step = '准备配置文件夹'
    Initialize-StateDir
    if ($TargetName) {
        Assert-TargetControlSupport
        $chosen = @(Get-CloudTargets | Where-Object { $_.name -ceq $TargetName })
        $running = Get-LinkStatus
        if ($chosen.Count -eq 1 -and $chosen[0].autoLogin -eq $true -and $running -and $running.pid -and (Get-Process -Id ([int]$running.pid) -ErrorAction SilentlyContinue) -and $running.autoLoginProtocol -ne 1) {
            throw '当前后台不支持网页自动登录。请在方便时手动停止旧后台并启动新版；程序不会自动中断其他云电脑。'
        }
        $script:Control = Set-TargetConnection $TargetName $true -RequestTime $RequestTime
    }
    $lockDeadline = [DateTime]::UtcNow.AddSeconds(60)
    do {
        try { $locked = $lock.WaitOne(250) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if ($TargetName) {
            $wanted = @((Get-TargetControls).targets | Where-Object { $_.name -ceq $TargetName })
            if (!$wanted.Count -or !$wanted[0].enabled -or $wanted[0].revision -ne $script:Control.revision) { throw '所选云电脑的启动已被停止或更改。' }
        }
    } while (!$locked -and [DateTime]::UtcNow -lt $lockDeadline)
    if (!$locked) { throw '已经有一个启动窗口正在运行，请等待它完成。' }
    Test-Environment
    $targets = Confirm-Targets
    Start-Background
    # Serialize initialization only; waiting for A's browser must not block B.
    $lock.ReleaseMutex()
    $locked = $false
    Wait-Connected $targets
    $restart = Install-Connectors $targets
    Write-Line ''
    $config = Get-LocalConfig
    Write-Line ('Claude 现在可以使用本机的文件、命令和已安装程序（盘符：' + ($config.roots -join ', ') + '）。')
    if ($restart) { Write-Warn '首次安装或更新：请在云电脑上完全退出 Claude 并重新打开一次。' }
    Write-Line '现在可以关闭此窗口。共享模式重启电脑后，请用 Open-CloudPC.bat 打开网页并登录。网络中断只重连，不会重复登录。'
    Write-Line '在管理界面选中云电脑后停止，只断开该目标；Stop-Claude-MCP.bat 是停止全部连接。'
    $success = $true
} catch {
    $message = Get-ChineseError $_
    $cancelled = $TargetName -and $message -in @('所选云电脑的启动已被停止或更改。','此操作已被较新的启动或停止操作取代。')
    if ($cancelled) { Write-Line '此云电脑的启动已取消，其他连接保持不变。' }
    else {
        Write-ErrorLog $script:Step $_
        if ($ManagerMode -and $message -like '当前后台不支持网页自动登录*') { Send-ManagerEvent 'error' '当前后台为旧版，不支持自动登录。请在方便时手动停止旧后台并启动新版；其他连接不会被自动中断。' }
        else { Write-Err ($script:Step + '失败：' + $message) }
        if ($message -ne '已取消。' -and $message -notmatch '^已取消') { Write-Line ('详细信息已记录到：' + $ErrorLog) 'DimGray' }
    }
} finally {
    if ($locked) { $lock.ReleaseMutex() }
    $lock.Dispose()
}
if ($ManagerMode) {
    if ($success) { Send-ManagerEvent 'complete' '连接准备完成，连接状态以后台确认为准。'; exit 0 }
    if ($cancelled) { Send-ManagerEvent 'complete' '此云电脑的启动已取消。'; exit 0 }
    exit 1
}
if ($TargetName -and ($success -or $cancelled)) {
    # Do not leave a completed wizard blocking the next selected start.
    if ($script:Progress -and !$script:Progress.Form.IsDisposed) {
        $script:Progress.Close.Enabled = $true
        Wait-Ui 1000
        $script:Progress.Form.Close()
    }
    exit 0
}
if ($success) { Complete-ProgressWindow '连接成功' $true; exit 0 }
Complete-ProgressWindow '启动失败' $false
exit 1
