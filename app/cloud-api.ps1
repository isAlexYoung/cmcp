# 通过网页桌面的接口操作云电脑：登录、读写文件、执行命令。
$ErrorActionPreference = 'Stop'

function Connect-CloudPc([string]$BaseUrl, [string]$Password) {
    if ((Get-CloudAuthMode $BaseUrl) -eq 'shared-browser') { throw '这台云电脑使用共享网页会话，请通过 Open-CloudPC.bat 打开；禁止后台再次登录。' }
    $script:CloudBase = $BaseUrl.TrimEnd('/')
    $script:CloudSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    $null = Invoke-CloudApi '/api/auth/login' 'POST' @{ password = $Password; remember = $false }
}

function Invoke-CloudApi($Path, $Method = 'GET', $Body = $null) {
    $params = @{ Uri = ($script:CloudBase + $Path); Method = $Method; WebSession = $script:CloudSession; TimeoutSec = 40; ErrorAction = 'Stop'; UseBasicParsing = $true }
    if ($null -ne $Body) {
        $params.ContentType = 'application/json; charset=utf-8'
        $params.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 30 -Compress))
    }
    Invoke-RestMethod @params
}

function Get-CloudFile($Path) {
    (Invoke-CloudApi ('/api/sys/fs?read=1&path=' + [uri]::EscapeDataString($Path))).content
}

function Set-CloudFile($Path, $Content) {
    $parent = $Path.Substring(0, $Path.LastIndexOf('/'))
    $name = $Path.Substring($Path.LastIndexOf('/') + 1)
    $listing = Invoke-CloudApi ('/api/sys/fs?hidden=1&path=' + [uri]::EscapeDataString($parent))
    $existing = @($listing.entries | Where-Object { $_.name -eq $name })
    if ($existing.Count) {
        if ($existing[0].kind -ne 'file') { throw '云电脑上的目标不是文件' }
        $null = Invoke-CloudApi '/api/sys/fs' 'PUT' @{ path = $Path; content = $Content }
    } else {
        $null = Invoke-CloudApi '/api/sys/fs' 'POST' @{ dir = $parent; name = $name; kind = 'file'; content = $Content }
    }
}

# $ExitMessages：命令的退出码 -> 中文说明（不能把中文提示写进命令本身：终端会回显命令，输出里就总能找到它）
function Invoke-CloudCommand($Command, $WorkingDirectory, $TimeoutSeconds = 180, [hashtable]$ExitMessages = @{}) {
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $ws.Options.Cookies = $script:CloudSession.Cookies
    # 与浏览器一样使用 Windows 的网络设置
    try { $ws.Options.Proxy = [Net.WebRequest]::GetSystemWebProxy() } catch {}
    $cancel = New-Object System.Threading.CancellationTokenSource
    $cancel.CancelAfter($TimeoutSeconds * 1000)
    $builder = New-Object Text.StringBuilder
    $script:CloudExitCode = $null
    try {
        # 网页桌面的终端把 cmd 注入交互式 shell 执行
        $terminalCommand = $Command + '; exit $?'
        $url = ($script:CloudBase -replace '^http', 'ws') + '/api/term/ws?sid=' + [guid]::NewGuid().ToString('N') + '&cols=200&rows=30&cwd=' + [uri]::EscapeDataString($WorkingDirectory) + '&cmd=' + [uri]::EscapeDataString($terminalCommand)
        $null = $ws.ConnectAsync([uri]$url, $cancel.Token).GetAwaiter().GetResult()
        $resize = [Text.Encoding]::UTF8.GetBytes('{"t":"r","c":200,"r":30}')
        $null = $ws.SendAsync([ArraySegment[byte]]::new($resize), [Net.WebSockets.WebSocketMessageType]::Text, $true, $cancel.Token).GetAwaiter().GetResult()
        $buffer = New-Object byte[] 65536
        $segment = [ArraySegment[byte]]::new($buffer)
        while ($ws.State -eq [Net.WebSockets.WebSocketState]::Open) {
            $stream = New-Object IO.MemoryStream
            do {
                $received = $ws.ReceiveAsync($segment, $cancel.Token).GetAwaiter().GetResult()
                if ($received.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { break }
                $stream.Write($buffer, 0, $received.Count)
            } while (!$received.EndOfMessage)
            $data = [Text.Encoding]::UTF8.GetString($stream.ToArray())
            $stream.Dispose()
            if ($received.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Binary) {
                [void]$builder.Append($data)
            } elseif ($received.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Text) {
                $message = $data | ConvertFrom-Json
                if ($message.t -eq 'error') { throw 'start' }
                if ($message.t -eq 'exit') {
                    if ($message.code -ne 0) {
                        $script:CloudExitCode = [int]$message.code
                        throw ('exit ' + $message.code)
                    }
                    return $builder.ToString()
                }
            }
        }
        throw 'closed'
    } catch {
        # 原始输出（英文）只写日志；界面显示中文。连接组件自己的中文错误（ERROR: ...）原样显示。
        $output = $builder.ToString()
        Write-ErrorLog ('在云电脑上执行命令：' + $Command) $_
        try { [IO.File]::AppendAllText($script:ErrorLog, "输出：`r`n" + $output + "`r`n`r`n", [Text.UTF8Encoding]::new($false)) } catch {}
        if ($null -ne $script:CloudExitCode -and $ExitMessages.ContainsKey($script:CloudExitCode)) { throw $ExitMessages[$script:CloudExitCode] }
        $own = [regex]::Match($output, 'ERROR: ([^\r\n]*[\u4e00-\u9fff][^\r\n]*)')
        if ($own.Success) { throw $own.Groups[1].Value.Trim() }
        throw '在云电脑上执行配置命令失败，请稍后重试。'
    } finally {
        $ws.Dispose()
        $cancel.Dispose()
    }
}

# 在云电脑上安装/更新连接组件，并确认云电脑上的 Claude 配置指向它。返回 'installed'（需要重启 Claude）| 'current'。
# 每次都运行安装程序（它只在需要时才修改文件）：不能只比较版本号，因为别的电脑上的旧版本
# 可能已经把 Claude 的配置改成了旧的连接方式，这时版本号相同但 Claude 连不到本机。
function Install-CloudConnector([string]$KitDir, [string]$Version) {
    $info = Invoke-CloudApi '/api/sys/info?lite=1'
    $homePath = [string]$info.home
    if ($homePath -notmatch '^/[a-zA-Z0-9_./-]+$') { throw '云电脑的用户目录异常' }
    $stage = $homePath + '/.local/share/cloudpc-link'
    $code = [IO.File]::ReadAllText((Join-Path $KitDir 'cloudpc-connector.py'), [Text.Encoding]::UTF8)
    try {
        Set-CloudFile ($stage + '/cloudpc-connector.py') $code
    } catch {
        # 第一次安装：文件夹还不存在
        $null = Invoke-CloudCommand "mkdir -p '$stage' && chmod 700 '$stage'" $homePath 30
        Set-CloudFile ($stage + '/cloudpc-connector.py') $code
    }
    $py = 'python3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" || exit 79'
    $result = Invoke-CloudCommand "bash -lc '$py; chmod 700 $stage; chmod 600 $stage/cloudpc-connector.py; python3 $stage/cloudpc-connector.py install --wait 60'" $homePath 240 @{ 79 = '云电脑缺少 Python 3.9 或更新版本，请联系管理员安装' }
    if ($result -notmatch 'Connected: (\d+) Windows tools') { throw '云电脑没有确认连接成功' }
    $changed = [regex]::Match($result, 'Config changed: (\d+)')
    if (!$changed.Success) { throw '云电脑上的连接组件版本不匹配，请重新解压完整的压缩包后再试' }
    if ([int]$changed.Groups[1].Value -gt 0 -or $result -match 'Connector updated: yes') { return 'installed' }
    return 'current'
}
