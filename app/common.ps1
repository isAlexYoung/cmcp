# 公共函数：设置目录、云电脑地址/密码的整理与校验、登录测试、加密保存。
# 被其它脚本用点号引入：. (Join-Path $PSScriptRoot 'common.ps1')
$ErrorActionPreference = 'Stop'
try { Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop } catch {}
try { Add-Type -AssemblyName System.Security } catch {}
# Windows PowerShell 5.1 在旧系统上默认可能不启用 TLS 1.2，云电脑地址需要它
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$script:KitVersion = '4.8.2'
$script:KitDir = $PSScriptRoot
$script:StateDir = if ($env:CMCP_STATE_DIR) { [IO.Path]::GetFullPath($env:CMCP_STATE_DIR) } else { Join-Path (Split-Path $PSScriptRoot -Parent) 'user' }
$script:TargetsFile = Join-Path $script:StateDir 'cloudpc-targets.json'
$script:StopFlag = Join-Path $script:StateDir 'stopped.flag'
$script:StatusFile = Join-Path $script:StateDir 'link-status.json'
$script:RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$script:RunName = 'ClaudeCloudPcLink'

# Invoke-WebRequest 的进度条会盖住窗口里的文字，而且会明显拖慢下载
$ProgressPreference = 'SilentlyContinue'

function Assert-PrivateStatePath([string]$Path) {
    $current=[IO.Path]::GetFullPath($Path)
    while($current){
        if(Test-Path -LiteralPath $current){$item=Get-Item -LiteralPath $current -Force;if(!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unsafe user directory path'}}
        $current=[IO.Path]::GetDirectoryName($current)
    }
}

function Initialize-PortableState([string]$Destination,[string]$Legacy) {
    Assert-PrivateStatePath $Destination
    if (Test-Path -LiteralPath $Destination) {
        if ((Get-Item -LiteralPath $Destination -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe user directory' }
        return
    }
    $parent=Split-Path $Destination -Parent
    $stage=Join-Path $parent ('.cmcp-user-'+[guid]::NewGuid().ToString('N'))
    $null=New-Item -ItemType Directory -Path $stage
    try {
        if (Test-Path -LiteralPath $Legacy) {
            Assert-PrivateStatePath $Legacy
            if ((Get-Item -LiteralPath $Legacy -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe legacy user directory' }
            foreach ($name in @('config.json','cloudpc-targets.json','vps-targets.json','target-controls.json','control-order.txt','application-preferences.json','dashboard-preferences.json','manager-preferences.json','node-extra-args.txt','machine-id')) {
                $file=Join-Path $Legacy $name
                if (!(Test-Path -LiteralPath $file)) { continue }
                $item=Get-Item -LiteralPath $file -Force
                if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe legacy user file' }
                [IO.File]::Copy($file,(Join-Path $stage $name),$false)
            }
        }
        $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        & icacls.exe $stage /inheritance:r /grant:r ('*'+$sid+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Cannot protect user data' }
        [IO.Directory]::Move($stage,$Destination)
    } finally {
        if ([IO.Directory]::Exists($stage) -and [IO.Path]::GetDirectoryName($stage) -eq $parent -and [IO.Path]::GetFileName($stage) -match '^\.cmcp-user-[a-f0-9]{32}$') { Remove-Item -LiteralPath $stage -Recurse -Force }
    }
}

function Initialize-StateDir {
    if ($script:StateDir -ieq (Join-Path (Split-Path $script:KitDir -Parent) 'user')) {
        Initialize-PortableState $script:StateDir (Join-Path $env:LOCALAPPDATA 'ClaudeLocalMcp')
    }
    New-Item -ItemType Directory -Path $script:StateDir -Force | Out-Null
    # 用 SID 而不是账户名：中文账户名、微软账户、域账户在 icacls 里都可能解析失败
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $r = Invoke-Quiet 'icacls.exe' @($script:StateDir, '/inheritance:r', '/grant:r', "*${sid}:(OI)(CI)F", '*S-1-5-18:(OI)(CI)F')
    if ($r.Code -ne 0) {
        Write-ErrorLog '设置配置文件夹权限' ([Management.Automation.ErrorRecord]::new([Exception]::new("icacls exit $($r.Code): $($r.Output)"), 'icacls', 'NotSpecified', $null))
        throw '无法设置配置文件夹的访问权限'
    }
}

function Write-Utf8File([string]$path, [string]$text) {
    $tmp = $path + '.tmp'
    [IO.File]::WriteAllText($tmp, $text, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tmp -Destination $path -Force
}

function Read-JsonFile([string]$path) {
    if (!(Test-Path -LiteralPath $path)) { return $null }
    $raw = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
    if (!$raw.Trim()) { return $null }
    return ($raw | ConvertFrom-Json)
}

# 本机 MCP 服务的端口和密钥（只在本机 127.0.0.1 使用）
function Get-LocalConfig {
    $path = Join-Path $script:StateDir 'config.json'
    $config = Read-JsonFile $path
    if (!$config) {
        $bytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        $rng.GetBytes($bytes); $rng.Dispose()
        $token = ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
        $roots = @(Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root -match '^[A-Za-z]:\\$' -and (Test-Path -LiteralPath $_.Root -PathType Container) } | Select-Object -ExpandProperty Root -Unique)
        $config = [pscustomobject]@{ port = 18765; token = $token; roots = $roots }
        Write-Utf8File $path ($config | ConvertTo-Json)
    }
    return $config
}

# ---------------- 地址与密码整理 ----------------

# 全角字母数字与常见全角符号转半角，去掉空格、换行和零宽等不可见字符
function ConvertTo-HalfWidth([string]$text) {
    $sb = New-Object Text.StringBuilder
    foreach ($ch in $text.ToCharArray()) {
        $code = [int]$ch
        if ($code -eq 0x3000) { [void]$sb.Append(' ') }
        elseif ($code -ge 0xFF01 -and $code -le 0xFF5E) { [void]$sb.Append([char]($code - 0xFEE0)) }
        elseif ($code -eq 0x3002) { [void]$sb.Append('.') }  # 中文句号
        else { [void]$sb.Append($ch) }
    }
    return $sb.ToString()
}

function Remove-Invisible([string]$text) {
    # 空白、控制字符、零宽字符、BOM、不换行空格
    return ($text -replace '[\s\p{Cc}\p{Cf} ​-‏ - ⁠﻿]', '')
}

# 返回整理后的 https://主机[:端口]，格式不对时抛出中文提示
function Get-NormalizedUrl([string]$raw) {
    $text = Remove-Invisible (ConvertTo-HalfWidth ([string]$raw))
    $text = $text.Trim('"', "'", '<', '>')
    if (!$text) { throw '地址不能为空' }
    if ($text -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*://') { $text = 'https://' + $text }
    $text = $text -replace '^(?i)http://', 'https://'
    $uri = $null
    if (![Uri]::TryCreate($text, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https' -or !$uri.Host) {
        throw '地址格式不正确，应类似 https://xxxx.app'
    }
    if ($uri.Host -notmatch '\.' -or $uri.Host -notmatch '^[a-zA-Z0-9.-]+$') { throw '地址格式不正确，应类似 https://xxxx.app' }
    $base = 'https://' + $uri.Host.ToLowerInvariant()
    if (!$uri.IsDefaultPort) { $base += ':' + $uri.Port }
    return $base
}

# 密码只包含英文和数字：去掉其它所有字符（复制粘贴时常带进来的空格、换行、引号等）
function Get-NormalizedPassword([string]$raw) {
    $half = ConvertTo-HalfWidth ([string]$raw)
    $clean = $half -replace '[^A-Za-z0-9]', ''
    return [pscustomobject]@{ Value = $clean; Removed = ([string]$raw).Length - $clean.Length }
}

# ---------------- 登录测试（区分地址错误 / 密码错误 / 网络问题） ----------------

function Get-HttpErrorInfo($errorRecord) {
    $ex = $errorRecord.Exception
    while ($ex -and !($ex -is [Net.WebException]) -and $ex.InnerException) { $ex = $ex.InnerException }
    $info = [pscustomobject]@{ Status = $null; Code = 0; Body = $null; Message = $errorRecord.Exception.Message }
    if ($errorRecord.Exception.GetType().Name -eq 'HttpResponseException') {
        # PowerShell 7
        $info.Code = [int]$errorRecord.Exception.Response.StatusCode
        $info.Body = $errorRecord.ErrorDetails.Message
        return $info
    }
    $inner = $errorRecord.Exception
    while ($inner) {
        if ($inner -is [Net.Sockets.SocketException]) {
            if ($inner.SocketErrorCode -in @('HostNotFound', 'NoData', 'TryAgain')) { $info.Status = 'NameResolutionFailure' } else { $info.Status = 'ConnectFailure' }
        }
        if ($inner -is [Security.Authentication.AuthenticationException]) { $info.Status = 'TrustFailure' }
        $inner = $inner.InnerException
    }
    if ($ex -is [Net.WebException]) {
        $info.Status = [string]$ex.Status
        if ($ex.Response) {
            $info.Code = [int]$ex.Response.StatusCode
            try {
                $reader = New-Object IO.StreamReader($ex.Response.GetResponseStream(), [Text.Encoding]::UTF8)
                $info.Body = $reader.ReadToEnd(); $reader.Dispose()
            } catch {}
        }
    }
    return $info
}

function Test-InternetUp {
    foreach ($h in @('www.baidu.com', 'www.qq.com', 'www.microsoft.com')) {
        try { if ([Net.Dns]::GetHostAddresses($h).Count) { return $true } } catch {}
    }
    return $false
}

# 返回 @{ Ok; Kind = ok|url|password|locked|expired|notset|network; Message }
function Test-CloudAddress([string]$baseUrl) {
    try {
        $r = Invoke-WebRequest -Uri ($baseUrl + '/api/health') -UseBasicParsing -TimeoutSec 20 -MaximumRedirection 0
        $json = $null
        try { $json = $r.Content | ConvertFrom-Json } catch {}
        if ($json -and $json.ok -eq $true) { return [pscustomobject]@{ Ok = $true; Kind = 'ok'; Message = '' } }
        return [pscustomobject]@{ Ok = $false; Kind = 'url'; Message = '这个地址不是云电脑连接地址，请检查后重新输入' }
    } catch {
        $e = Get-HttpErrorInfo $_
        if ($e.Status -eq 'NameResolutionFailure') {
            if (!(Test-InternetUp)) { return [pscustomobject]@{ Ok = $false; Kind = 'network'; Message = '本机网络不可用，请检查网络连接后重试' } }
            return [pscustomobject]@{ Ok = $false; Kind = 'url'; Message = '找不到这个地址，请检查云电脑连接地址是否输入正确' }
        }
        # 网页桌面自己的健康检查失败时返回 {"ok":false}；其它错误页说明地址不对或云电脑没在运行
        if ($e.Code -eq 500 -and $e.Body -match '^\s*\{\s*"ok"\s*:\s*false') { return [pscustomobject]@{ Ok = $false; Kind = 'network'; Message = '云电脑服务暂时异常，请稍后再试' } }
        if ($e.Body -match 'sandbox was not found') { return [pscustomobject]@{ Ok = $false; Kind = 'url'; Message = '找不到这台云电脑：地址有误，或云电脑已关闭' } }
        if ($e.Code -gt 0) { return [pscustomobject]@{ Ok = $false; Kind = 'url'; Message = "这个地址不是云电脑连接地址，或云电脑当前未运行（HTTP $($e.Code)）" } }
        if ($e.Status -eq 'TrustFailure' -or $e.Status -eq 'SecureChannelFailure') { return [pscustomobject]@{ Ok = $false; Kind = 'url'; Message = '无法建立安全连接，请检查地址是否正确' } }
        if (!(Test-InternetUp)) { return [pscustomobject]@{ Ok = $false; Kind = 'network'; Message = '本机网络不可用，请检查网络连接后重试' } }
        return [pscustomobject]@{ Ok = $false; Kind = 'url'; Message = '无法连接到这个地址，请检查地址是否正确，或确认云电脑正在运行' }
    }
}

function Test-CloudLogin([string]$baseUrl, [string]$password) {
    $address = Test-CloudAddress $baseUrl
    if (!$address.Ok) { return $address }
    $mode = Get-CloudAuthMode $baseUrl
    if ($mode -eq 'shared-browser') { return [pscustomobject]@{ Ok = $true; Kind = 'shared'; AuthMode = $mode; Message = '请通过打开云电脑入口登录，MCP 将共用网页会话' } }
    $body = [Text.Encoding]::UTF8.GetBytes((@{ password = $password; remember = $false } | ConvertTo-Json -Compress))
    try {
        $null = Invoke-WebRequest -Uri ($baseUrl + '/api/auth/login') -Method Post -Body $body -ContentType 'application/json; charset=utf-8' -UseBasicParsing -TimeoutSec 30 -MaximumRedirection 0
        return [pscustomobject]@{ Ok = $true; Kind = 'ok'; Message = '' }
    } catch {
        $e = Get-HttpErrorInfo $_
        $json = $null
        try { $json = $e.Body | ConvertFrom-Json } catch {}
        $serverMessage = if ($json -and $json.error) { [string]$json.error } else { '' }
        switch ($e.Code) {
            401 { return [pscustomobject]@{ Ok = $false; Kind = 'password'; Message = $(if ($serverMessage) { $serverMessage } else { '密码不正确' }) } }
            429 { return [pscustomobject]@{ Ok = $false; Kind = 'locked'; Message = $(if ($serverMessage) { $serverMessage } else { '尝试次数过多，请稍后再试' }) } }
            403 { if ($json -and $json.expired) { return [pscustomobject]@{ Ok = $false; Kind = 'expired'; Message = '云电脑访问密码已过期，请联系管理员续期' } } }
            503 { if ($json -and $json.notSet) { return [pscustomobject]@{ Ok = $false; Kind = 'notset'; Message = '云电脑尚未设置访问密码，请联系管理员' } } }
        }
        if ($e.Code -gt 0) { return [pscustomobject]@{ Ok = $false; Kind = 'url'; Message = "这个地址不是云电脑连接地址（HTTP $($e.Code)）" } }
        return [pscustomobject]@{ Ok = $false; Kind = 'network'; Message = '连接云电脑时网络中断，请重试' }
    }
}

# ---------------- 云电脑列表（密码用 Windows DPAPI 加密，仅当前账户可解密） ----------------

function Protect-Text([string]$plain) {
    $bytes = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($plain), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    return [Convert]::ToBase64String($bytes)
}

function Unprotect-Text([string]$cipher) {
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($cipher), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    return [Text.Encoding]::UTF8.GetString($bytes)
}

function Get-CloudTargets {
    Import-LegacyTargets
    $list = Read-JsonFile $script:TargetsFile
    if (!$list) { return @() }
    return @($list)
}

function Save-CloudTarget([string]$name, [string]$url, [string]$password, [string]$authMode = '', [bool]$AutoLogin = $false) {
    if (!$authMode) { $authMode = Get-CloudAuthMode $url }
    if ($AutoLogin -and ($authMode -ne 'shared-browser' -or !$password)) { throw '共享自动登录需要保存密码。' }
    Invoke-TargetStateLock {
    $targets = @(Get-CloudTargets | Where-Object { $_.name -ne $name })
    $cipher = if ($authMode -eq 'shared-browser' -and !$AutoLogin) { $null } else { Protect-Text $password }
    $targets += [pscustomobject]@{ name = $name; url = $url; password = $cipher; authMode = $authMode; autoLogin = $AutoLogin; stamp = [DateTime]::UtcNow.ToString('o') }
    Write-TargetStateFile $script:TargetsFile (ConvertTo-Json -InputObject @($targets) -Depth 5)
    }
}

function Get-CloudAuthMode([string]$url) {
    $node = Get-NodeExe
    $argsForNode = @(Get-SavedNodeArgs) + @('"' + (Join-Path $KitDir 'detect-auth.mjs') + '"', '"' + $url + '"')
    $r = Invoke-Capture $node $argsForNode 120 $KitDir
    $mode = $r.Out.Trim()
    if ($r.Code -ne 0 -or $mode -notin @('shared-browser','legacy')) { throw '无法安全识别云电脑登录协议，请检查地址和网络后重试；程序没有提交密码。' }
    return $mode
}

function Open-SharedCloudBrowser([string]$name = '') {
    try { $entries = Read-JsonFile (Join-Path $StateDir 'browser-entries.json') } catch { return $false }
    if (!$entries -or !$entries.pid -or !(Get-Process -Id ([int]$entries.pid) -ErrorAction SilentlyContinue)) { return $false }
    $opened = $false
    foreach ($entry in @($entries.targets)) {
        if ($name -and $entry.name -ne $name) { continue }
        $uri = $null
        if ([Uri]::TryCreate([string]$entry.launchUrl, [UriKind]::Absolute, [ref]$uri) -and $uri.Scheme -eq 'http' -and $uri.Host -eq '127.0.0.1' -and $uri.AbsolutePath -eq '/__mcp/open' -and $uri.Fragment -match '^#[A-Za-z0-9_-]{43}$') {
            Start-Process -FilePath $uri.AbsoluteUri
            $opened = $true
        }
    }
    return $opened
}

function Remove-CloudTarget([string]$name) {
    Invoke-TargetStateLock {
    $targets = @(Get-CloudTargets | Where-Object { $_.name -ne $name })
    Write-TargetStateFile $script:TargetsFile (ConvertTo-Json -InputObject @($targets) -Depth 5)
    }
}

# 旧版本保存的设置文件：转换成新格式后删除
function Import-LegacyTargets {
    $legacy = Join-Path $script:StateDir 'vps-targets.json'
    if (!(Test-Path -LiteralPath $legacy) -or (Test-Path -LiteralPath $script:TargetsFile)) { return }
    $converted = @()
    foreach ($t in @(Read-JsonFile $legacy)) {
        try {
            $secure = $t.password | ConvertTo-SecureString
            $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
            try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
            $converted += [pscustomobject]@{ name = $t.name; url = (Get-NormalizedUrl $t.url); password = (Protect-Text $plain); stamp = [DateTime]::UtcNow.ToString('o') }
        } catch {}
    }
    Write-Utf8File $script:TargetsFile (ConvertTo-Json -InputObject @($converted) -Depth 5)
    Remove-Item -LiteralPath $legacy -Force
}

# ---------------- 错误处理：界面只显示中文，英文原文写入日志 ----------------

$script:ErrorLog = Join-Path $script:StateDir 'error.log'

function Write-ErrorLog([string]$step, $errorRecord) {
    try {
        if(!(Test-Path -LiteralPath $script:StateDir) -and $script:StateDir -ieq (Join-Path (Split-Path $script:KitDir -Parent) 'user')){return}
        New-Item -ItemType Directory -Path $script:StateDir -Force | Out-Null
        $text = "[{0}] 步骤：{1}`r`n{2}`r`n{3}`r`n{4}`r`n`r`n" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $step,
            $errorRecord.Exception.GetType().FullName, $errorRecord.Exception.Message, $errorRecord.ScriptStackTrace
        [IO.File]::AppendAllText($script:ErrorLog, $text, [Text.UTF8Encoding]::new($false))
    } catch {}
}

# 把异常转换成中文说明。我们自己抛出的错误本来就是中文，原样显示。
function Get-ChineseError($errorRecord) {
    $ex = $errorRecord.Exception
    while ($ex -is [Management.Automation.RuntimeException] -and $ex.InnerException) { $ex = $ex.InnerException }
    $message = [string]$ex.Message
    if ($message -match '[一-鿿]') { return $message }
    if ($ex -is [UnauthorizedAccessException] -or $ex -is [Security.SecurityException]) {
        return '没有权限完成这个操作，可能被杀毒软件或系统安全策略拦截。请把本文件夹加入杀毒软件的信任列表后重试。'
    }
    if ($ex -is [IO.FileNotFoundException] -or $ex -is [IO.DirectoryNotFoundException]) { return '找不到需要的文件，请重新解压完整的压缩包后再试。' }
    if ($ex -is [IO.IOException]) { return '文件被占用或无法读写，请关闭其它窗口后重试。' }
    # 按类型名比较：Windows PowerShell 5.1 默认没有加载 System.Net.Http，直接写类型会让这里本身出错
    if ($ex -is [Net.WebException] -or $ex.GetType().FullName -eq 'System.Net.Http.HttpRequestException' -or $ex -is [Net.Sockets.SocketException]) { return '网络连接失败，请检查网络后重试。' }
    if ($ex -is [TimeoutException] -or $ex -is [OperationCanceledException]) { return '操作超时，请检查网络后重试。' }
    if ($ex -is [Security.Cryptography.CryptographicException]) { return '无法读取保存的密码（可能换了 Windows 账户），请重新输入。' }
    return '发生了意外错误。'
}

# ---------------- 外部程序（不让英文错误输出触发异常） ----------------

function Invoke-Quiet([string]$exe, [string[]]$arguments) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $out = & $exe @arguments 2>&1 | Out-String; return [pscustomobject]@{ Code = $LASTEXITCODE; Output = $out } }
    catch { return [pscustomobject]@{ Code = -1; Output = '' } }
    finally { $ErrorActionPreference = $old }
}

# 运行一个程序并捕获标准输出、错误输出和退出码，超时自动结束。返回 @{ Code; Out; Err; TimedOut }
function Invoke-Capture([string]$exe, [string[]]$arguments, [int]$timeoutSec = 60, [string]$workDir = $null) {
    $outFile = [IO.Path]::GetTempFileName()
    $errFile = [IO.Path]::GetTempFileName()
    try {
        $params = @{ FilePath = $exe; ArgumentList = $arguments; PassThru = $true; RedirectStandardOutput = $outFile; RedirectStandardError = $errFile }
        # -WindowStyle 在 Windows 上隐藏控制台窗口；PowerShell 7（非 Windows）不支持这个参数
        if ($PSVersionTable.PSEdition -ne 'Core' -or $IsWindows) { $params.WindowStyle = 'Hidden' }
        if ($workDir) { $params.WorkingDirectory = $workDir }
        $p = Start-Process @params
        $null = $p.Handle  # 重定向输出时必须先取一次句柄，否则进程结束后拿不到退出码
        if (!$p.WaitForExit($timeoutSec * 1000)) {
            try { $p.Kill() } catch {}
            return [pscustomobject]@{ Code = -2; Out = ''; Err = ''; TimedOut = $true }
        }
        $out = (Get-Content -LiteralPath $outFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)
        $err = (Get-Content -LiteralPath $errFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)
        return [pscustomobject]@{ Code = $p.ExitCode; Out = [string]$out; Err = [string]$err; TimedOut = $false }
    } catch {
        return [pscustomobject]@{ Code = -1; Out = ''; Err = $_.Exception.Message; TimedOut = $false }
    } finally {
        Remove-Item -LiteralPath $outFile, $errFile -Force -ErrorAction SilentlyContinue
    }
}

# ---------------- 后台服务（开机自启 + 守护进程） ----------------

function Get-NodeExe {
    $bundled = Join-Path $script:KitDir 'runtime\node.exe'
    if (Test-Path -LiteralPath $bundled) { return $bundled }
    return $null
}

$script:NodeArgsFile = Join-Path $script:StateDir 'node-extra-args.txt'

# 内置 Node 启动 server.mjs 时要加的额外参数。--use-system-ca 让 Node 信任 Windows 证书库
# （有些安全软件会拦截 HTTPS），但较旧的 Node 不认这个参数。测一次是否支持并记下来。
function Resolve-NodeArgs([string]$node) {
    $extra = @()
    $test = Invoke-Capture $node @('--use-system-ca', '-e', '0') 10
    if ($test.Code -eq 0) { $extra = @('--use-system-ca') }
    try { Write-Utf8File $script:NodeArgsFile ($extra -join "`n") } catch {}
    return $extra
}

# run-service 读取上面记下的参数；没有记录时默认尝试 --use-system-ca
function Get-SavedNodeArgs {
    if (Test-Path -LiteralPath $script:NodeArgsFile) {
        $raw = [IO.File]::ReadAllText($script:NodeArgsFile, [Text.Encoding]::UTF8).Trim()
        return @($raw -split "`n" | Where-Object { $_ })
    }
    return @('--use-system-ca')
}

# 本工具的所有后台进程，不管在哪个文件夹（包括旧版本、长期/短期连接版和移动过位置的副本）：
#   - 守护进程 run-service.ps1（长期连接版）/ run-session.ps1（短期连接版）
#   - node 运行的 server.mjs（同目录下有 windows-tools.mjs 才算本工具的）
#   - 旧版的 cloudflared.exe（同一工具目录下的 bin\cloudflared.exe）
function Get-ServiceProcesses {
    $result = @()
    foreach ($p in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        $cmd = [string]$p.CommandLine
        if (!$cmd) { continue }
        if ($p.Name -notin @('node.exe', 'powershell.exe', 'pwsh.exe', 'cloudflared.exe')) { continue }
        $m = [regex]::Match($cmd, '(?i)"?([A-Za-z]:\\[^"]*?)\\(server\.mjs|run-service\.ps1|run-session\.ps1)"?')
        if ($m.Success) {
            $dir = $m.Groups[1].Value
            $marker = if ($m.Groups[2].Value -ieq 'server.mjs') { 'windows-tools.mjs' } else { 'common.ps1' }
            if (Test-Path -LiteralPath (Join-Path $dir $marker)) { $result += $p }
            elseif (!(Test-Path -LiteralPath $dir)) { $result += $p }  # 文件夹已被删除的旧副本
            continue
        }
        if ($p.Name -ieq 'cloudflared.exe' -and $p.ExecutablePath) {
            $kit = Split-Path (Split-Path $p.ExecutablePath -Parent) -Parent
            if ((Test-Path -LiteralPath (Join-Path $kit 'server.mjs')) -or !(Test-Path -LiteralPath $kit)) { $result += $p }
        }
    }
    return $result
}

function Invoke-LinkLifecycleLock([scriptblock]$Action) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $key = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($script:StateDir.ToLowerInvariant())))).Replace('-', '').Substring(0, 20) } finally { $hash.Dispose() }
    $mutex = New-Object Threading.Mutex($false, ('Local\ClaudeMcpLifecycle-' + $key))
    $owned = $false
    try {
        try { $owned = $mutex.WaitOne(90000) } catch [Threading.AbandonedMutexException] { $owned = $true }
        if (!$owned) { throw 'Backend lifecycle operation busy' }
        & $Action
    } finally { if ($owned) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}

function Stop-LinkService {
    Invoke-LinkLifecycleLock {
    # Ask the service to stop itself before attempting process termination.
    # This also works for a 3.2.1+ service launched at a higher integrity level.
    [IO.File]::WriteAllText($script:StopFlag, 'stop', [Text.UTF8Encoding]::new($false))
    $oldStatus = Get-LinkStatus
    if ($oldStatus -and $oldStatus.pid) {
        for ($i = 0; $i -lt 32; $i++) {
            if (!(Get-Process -Id ([int]$oldStatus.pid) -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 250
        }
    }
    # 短期连接版正在进行的"本次连接"：先请它自己结束（通知区域的图标才会正常消失），最多等 8 秒
    $session = Join-Path $script:StateDir 'session.json'
    if (Test-Path -LiteralPath $session) {
        Remove-Item -LiteralPath $session -Force -ErrorAction SilentlyContinue
        for ($i = 0; $i -lt 32; $i++) {
            if (!@(Get-ServiceProcesses | Where-Object { [string]$_.CommandLine -match '(?i)run-session\.ps1' }).Count) { break }
            Start-Sleep -Milliseconds 250
        }
    }
    # 先停守护进程，再停服务本身，避免守护进程把服务重新拉起
    $all = @(Get-ServiceProcesses | Sort-Object { if ([string]$_.CommandLine -match '(?i)\.ps1') { 0 } else { 1 } })
    foreach ($p in $all) {
        $null = Invoke-Quiet 'taskkill.exe' @('/PID', [string]$p.ProcessId, '/T', '/F')
    }
    # 等进程真正退出
    for ($i = 0; $i -lt 20; $i++) {
        if (!@(Get-ServiceProcesses).Count) { break }
        Start-Sleep -Milliseconds 250
    }
    $remaining = Get-LinkStatus
    if ($remaining -and $remaining.pid -and (Get-Process -Id ([int]$remaining.pid) -ErrorAction SilentlyContinue)) {
        $fresh = $false
        try { $fresh = ((Get-Date).ToUniversalTime() - [datetime]::Parse([string]$remaining.at).ToUniversalTime()).TotalSeconds -lt 20 } catch {}
        if ($fresh) { throw '旧后台服务仍在运行，当前窗口无法停止它。请右键 Start-CMCP.bat 选择“以管理员身份运行”完成这次升级；新版以后可直接停止。' }
    }
    }
}

function Remove-LegacyFiles {
    foreach ($name in @('tunnel-process.json', 'connection.json', 'tunnel.log', 'tunnel-error.log', 'last-session.json', 'server-process.json')) {
        $p = Join-Path $script:StateDir $name
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }
    }
}

$script:StartupDir = [Environment]::GetFolderPath('Startup')
$script:StartupLink = $(if ($script:StartupDir) { Join-Path $script:StartupDir 'Claude 云电脑连接.lnk' } else { '' })

# 登录 Windows 后自动启动。优先写当前用户的注册表启动项（只增加这一项，绝不改动其它启动项）；
# 被安全软件拦截时改用"启动"文件夹里的快捷方式。返回使用的方式。
function Get-ServiceCommand {
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $script:KitDir 'run-service.ps1') + '"'
    return [pscustomobject]@{ Exe = $ps; Arguments = $arguments }
}

function Register-AutoStart {
    $preferences = Join-Path $script:StateDir 'application-preferences.json'
    if (Test-Path -LiteralPath $preferences) {
        try {
            $options = Get-Content -LiteralPath $preferences -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($options.schema -ne 1 -or $options.autoStart -isnot [bool]) { throw 'Invalid application preferences' }
            if (!$options.autoStart) { Unregister-AutoStart; return 'disabled' }
            $manager = Join-Path (Split-Path $script:KitDir -Parent) 'CMCP.exe'
            if (!(Test-Path -LiteralPath $manager)) { throw 'CMCP manager is missing' }
            if (!(Test-Path -LiteralPath $script:RunKey)) { New-Item -Path $script:RunKey | Out-Null }
            $existing = (Get-ItemProperty -LiteralPath $script:RunKey -ErrorAction Stop).CMCPManager
            if ($existing -and $existing -notmatch '\\(?:CMCP|Claude-MCP)\.exe" --startup$') { throw 'Unrelated startup entry preserved' }
            New-ItemProperty -LiteralPath $script:RunKey -Name 'CMCPManager' -Value ('"'+$manager+'" --startup') -PropertyType String -Force | Out-Null
            Unregister-AutoStart
            return 'manager'
        } catch { Write-ErrorLog '设置开机自启' $_; return 'none' }
    }
    $svc = Get-ServiceCommand
    try {
        if (!(Test-Path -LiteralPath $script:RunKey)) { New-Item -Path $script:RunKey | Out-Null }
        New-ItemProperty -Path $script:RunKey -Name $script:RunName -Value ('"' + $svc.Exe + '" ' + $svc.Arguments) -PropertyType String -Force | Out-Null
        if ($script:StartupLink -and (Test-Path -LiteralPath $script:StartupLink)) { Remove-Item -LiteralPath $script:StartupLink -Force -ErrorAction SilentlyContinue }
        return 'registry'
    } catch {
        Write-ErrorLog '设置开机自启（注册表）' $_
    }
    if (!$script:StartupLink) { return 'none' }
    try {
        $shell = New-Object -ComObject WScript.Shell
        $link = $shell.CreateShortcut($script:StartupLink)
        $link.TargetPath = $svc.Exe
        $link.Arguments = $svc.Arguments
        $link.WorkingDirectory = $script:KitDir
        $link.WindowStyle = 7
        $link.Save()
        return 'startup-folder'
    } catch {
        Write-ErrorLog '设置开机自启（启动文件夹）' $_
        return 'none'
    }
}

function Unregister-AutoStart {
    try { Remove-ItemProperty -Path $script:RunKey -Name $script:RunName -ErrorAction Stop } catch {}
    if ($script:StartupLink -and (Test-Path -LiteralPath $script:StartupLink)) { Remove-Item -LiteralPath $script:StartupLink -Force -ErrorAction SilentlyContinue }
}

function Start-LinkService {
    Invoke-LinkLifecycleLock {
        $svc = Get-ServiceCommand
        Start-Process -FilePath $svc.Exe -ArgumentList $svc.Arguments -WindowStyle Hidden
    }
}

# 从网上下载的压缩包，解压出的文件带有"来自互联网"标记，可能被系统拦截或弹出安全警告：启动前统一解除
function Unblock-Kit {
    $marked = $false
    try { $marked = [bool](Get-Item -LiteralPath (Join-Path $script:KitDir 'start.ps1') -Stream 'Zone.Identifier' -ErrorAction Stop) } catch {}
    if (!$marked) { return }
    Get-ChildItem -LiteralPath $script:KitDir -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue
}

# 读取后台服务的状态文件。以"共享读写删除"方式打开，绝不妨碍服务更新这个文件。
function Get-LinkStatus {
    if (!(Test-Path -LiteralPath $script:StatusFile)) { return $null }
    try {
        $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
        $stream = New-Object IO.FileStream($script:StatusFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
        try { $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8); $raw = $reader.ReadToEnd() } finally { $stream.Dispose() }
        if (!$raw.Trim()) { return $null }
        return ($raw | ConvertFrom-Json)
    } catch { return $null }
}

. (Join-Path $PSScriptRoot 'target-controls.ps1')
