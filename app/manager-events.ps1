# UI worker protocol: only fixed, local messages; never forward credentials or
# backend output into the manager. BAT entry points keep their existing UI.
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Send-ManagerEvent([string]$Kind, [string]$Message, [string]$Name = '') {
    # Closing the manager detaches its progress pipe; it must not cancel a
    # requested background connection or a validated save.
    try {
        [Console]::WriteLine((ConvertTo-Json -Compress -InputObject @{ schema = 1; kind = $Kind; message = $Message; name = $Name }))
        [Console]::Out.Flush()
    } catch { }
}
function Write-Step([string]$Text) { Send-ManagerEvent 'progress' $Text }
function Write-Line { }
function Write-Ok { }
function Write-Warn { }
function Write-Err { Send-ManagerEvent 'error' '连接未完成，请检查地址、网络或本机日志；其他连接保持不变。' }
function Open-ProgressWindow { Send-ManagerEvent 'progress' '正在准备连接，可随时停止。' }
function Complete-ProgressWindow { }
function Show-Info([string]$Text) { Send-ManagerEvent 'progress' $Text }
function Show-Error { Send-ManagerEvent 'error' '操作未完成，请检查本机日志；其他连接保持不变。' }
function Show-CredentialDialog { throw '请返回卡片的编辑页面更新旧版密码。' }
function Wait-Ui([int]$Milliseconds) { Start-Sleep -Milliseconds $Milliseconds }
