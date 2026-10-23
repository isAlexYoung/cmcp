# 后台守护进程：保持本机服务运行，崩溃后自动重启。用户点"断开"后不再启动。
. (Join-Path $PSScriptRoot 'common.ps1')
$ErrorActionPreference = 'Continue'
$mutex = New-Object Threading.Mutex($false, 'Local\ClaudeCloudPcLinkService')
$owned = $false
try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
if (!$owned) { exit 0 }  # 已经在运行
try {
    if (Test-Path -LiteralPath $StopFlag) { exit 0 }
    $node = Get-NodeExe
    if (!$node) { exit 1 }
    $out = Join-Path $StateDir 'service-console.log'
    $err = Join-Path $StateDir 'service-console.err.log'
    $history = Join-Path $StateDir 'service-crash.log'
    $server = Join-Path $KitDir 'server.mjs'
    $extra = Get-SavedNodeArgs
    $delay = 3
    while (!(Test-Path -LiteralPath $StopFlag)) {
        $started = Get-Date
        # $extra 里可能有 --use-system-ca：使用 Windows 证书库，安全软件检查 HTTPS 时也能正常连接
        $p = Start-Process -FilePath $node -ArgumentList (@($extra) + @('"' + $server + '"')) -WorkingDirectory $KitDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
        $null = $p.Handle  # 重定向输出时必须先取一次句柄，否则拿不到退出码（就分不出"已有一份在运行"的退出码 3）
        $p.WaitForExit()
        $code = $p.ExitCode
        if ($code -eq 3) { break }  # 另一份服务已经在运行
        if (Test-Path -LiteralPath $StopFlag) { break }
        # 保留崩溃时的错误输出（下一次启动会覆盖控制台日志）
        try {
            $tail = (Get-Content -LiteralPath $err -Tail 30 -Encoding UTF8 -ErrorAction SilentlyContinue) -join "`r`n"
            if ((Test-Path -LiteralPath $history) -and (Get-Item -LiteralPath $history).Length -gt 2MB) { Remove-Item -LiteralPath $history -Force }
            [IO.File]::AppendAllText($history, ("[{0}] exit {1}`r`n{2}`r`n`r`n" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $code, $tail), [Text.UTF8Encoding]::new($false))
        } catch {}
        if (((Get-Date) - $started).TotalMinutes -gt 5) { $delay = 3 } else { $delay = [Math]::Min($delay * 2, 60) }
        Start-Sleep -Seconds $delay
    }
} finally {
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
