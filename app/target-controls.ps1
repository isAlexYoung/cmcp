# Only local preferences are written here. No login, remote request or process
# termination is performed. All writers use one account-scoped mutex.
function Invoke-TargetStateLock([scriptblock]$Action) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $key = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($script:StateDir.ToLowerInvariant())))).Replace('-', '').Substring(0, 20) } finally { $hash.Dispose() }
    $mutex = New-Object Threading.Mutex($false, ('Local\ClaudeMcpTargetControls-' + $key))
    $locked = $false
    try {
        try { $locked = $mutex.WaitOne(10000) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if (!$locked) { throw '连接设置正在被其他窗口更新，请稍后再试。' }
        & $Action
    } finally { if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}

function Write-TargetStateFile([string]$File, [string]$Json) {
    $tmp = $File + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($tmp, $Json, [Text.UTF8Encoding]::new($false))
        for ($attempt = 0; $attempt -lt 10; $attempt++) {
            try {
                if (Test-Path -LiteralPath $File) { [IO.File]::Replace($tmp, $File, [NullString]::Value) } else { [IO.File]::Move($tmp, $File) }
                return
            } catch [IO.IOException] { if ($attempt -eq 9) { throw }; Start-Sleep -Milliseconds 30 }
        }
    } finally { if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) } }
}

function Get-TargetControls {
    $file = Join-Path $script:StateDir 'target-controls.json'
    if (!(Test-Path -LiteralPath $file)) { return $null }
    if ((Get-Item -LiteralPath $file).Length -gt 262144) { throw '连接开关文件过大，请检查本机设置。' }
    $data = Read-JsonFile $file
    if (!$data -or $data.schema -ne 1 -or $null -eq $data.targets -or @($data.targets).Count -gt 100) { throw '连接开关文件损坏；为避免误连，不会自动重置。' }
    $seen = @{}
    foreach ($t in @($data.targets)) {
        if (!$t.name -or ([string]$t.name).Length -gt 512 -or $t.enabled -isnot [bool] -or !$t.revision -or $seen.ContainsKey([string]$t.name)) { throw '连接开关文件损坏；请检查本机设置。' }
        $seen[[string]$t.name] = $true
    }
    return $data
}

function Assert-TargetControlSupport {
    $s = Get-LinkStatus
    if ($s -and $s.pid -and (Get-Process -Id ([int]$s.pid) -ErrorAction SilentlyContinue) -and $s.controlProtocol -ne 1) {
        throw '旧版后台仍在运行，不支持逐台控制。请先使用 app\Stop-Claude-MCP.bat 停止全部旧连接一次，再用新界面启动。不会自动中断其他云电脑。'
    }
}

function Set-TargetConnection([string]$Name, [bool]$Enabled, [switch]$All, [long]$RequestTime = 0) {
    if (!$RequestTime) { $RequestTime = [DateTime]::UtcNow.Ticks }
    Invoke-TargetStateLock {
        $targets = @(Get-CloudTargets)
        if ($targets.Count -gt 100) { throw '最多支持 100 个保存的云电脑。' }
        if (!$All -and !@($targets | Where-Object { $_.name -ceq $Name }).Count) { throw '所选云电脑已不存在，请刷新列表。' }
        $old = Get-TargetControls
        $entries = @()
        foreach ($t in $targets) {
            $previous = @($old.targets | Where-Object { $_.name -ceq $t.name } | Select-Object -First 1)
            $enabledBefore = if ($previous.Count) { [bool]$previous[0].enabled } else { $false }
            $revision = if ($previous.Count) { [string]$previous[0].revision } else { 'legacy' }
            $selected = $All -or $t.name -ceq $Name
            $previousTime = if ($previous.Count -and $previous[0].requestTime) { [long]$previous[0].requestTime } else { 0 }
            if ($selected -and $RequestTime -lt $previousTime) { throw '此操作已被较新的启动或停止操作取代。' }
            $enabledNow = if ($selected) { $Enabled } else { $enabledBefore }
            # Starting an already enabled target is idempotent: no re-login.
            $restart = $false
            if ($selected -and $Enabled -and $enabledBefore) {
                $status = Get-LinkStatus
                $entry = if ($status -and $status.targets) { $status.targets.($t.name) } else { $null }
                $restart = $entry -and $entry.revision -eq $revision -and $entry.state -in @('replaced','error')
            }
            if ($selected -and ($enabledBefore -ne $enabledNow -or $restart)) { $revision = [Guid]::NewGuid().ToString('N') }
            $time = if ($selected) { [string]$RequestTime } else { [string]$previousTime }
            $entries += [pscustomobject]@{ name = [string]$t.name; enabled = [bool]$enabledNow; revision = $revision; requestTime = $time }
        }
        $file = Join-Path $script:StateDir 'target-controls.json'
        $json = ConvertTo-Json -InputObject ([pscustomobject]@{ schema = 1; targets = @($entries) }) -Depth 5
        Write-TargetStateFile $file $json
        return ($entries | Where-Object { $_.name -ceq $Name } | Select-Object -First 1)
    }
}
