# 中文窗口界面：进度窗口、云电脑地址/密码输入框、提示框。
# 用窗口代替黑色控制台，避免中文在控制台里显示重叠或乱码。
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

$script:UiFont = New-Object Drawing.Font('Microsoft YaHei UI', 10)
$script:UiTitle = 'Claude 云电脑连接'
$script:Progress = $null

# ---------------- 提示框 ----------------

# 系统提示框的按钮文字跟随 Windows 语言（英文系统显示 Yes/No），所以自己画一个中文提示框。
# 返回 'OK' / 'Yes' / 'No' / 'Retry' / 'Cancel'。
function Show-Box([string]$text, [string]$buttons, [string]$icon) {
    $form = New-Object Windows.Forms.Form
    $form.Text = $script:UiTitle
    $form.Font = $script:UiFont
    $form.FormBorderStyle = 'FixedDialog'
    $form.StartPosition = 'CenterScreen'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.TopMost = $true

    $picture = New-Object Windows.Forms.PictureBox
    $picture.Location = New-Object Drawing.Point(20, 20)
    $picture.Size = New-Object Drawing.Size(32, 32)
    $systemIcon = switch ($icon) { 'Error' { [Drawing.SystemIcons]::Error } 'Warning' { [Drawing.SystemIcons]::Warning } 'Question' { [Drawing.SystemIcons]::Question } default { [Drawing.SystemIcons]::Information } }
    $picture.Image = $systemIcon.ToBitmap()
    $form.Controls.Add($picture)

    $label = New-Object Windows.Forms.Label
    $label.Location = New-Object Drawing.Point(66, 22)
    $label.MaximumSize = New-Object Drawing.Size(440, 0)
    $label.AutoSize = $true
    $label.Text = $text
    $form.Controls.Add($label)
    $textSize = $label.GetPreferredSize((New-Object Drawing.Size(440, 0)))

    # 外层必须用 @(...)：switch 会把只有一个元素的数组拆开（按钮文字会变成单个字）
    $specs = @(switch ($buttons) {
        'YesNo' { @(@('是', 'Yes'), @('否', 'No')) }
        'RetryCancel' { @(@('重试', 'Retry'), @('取消', 'Cancel')) }
        default { @(, @('确定', 'OK')) }
    })
    $width = [Math]::Max(380, 66 + $textSize.Width + 30)
    $top = 22 + [Math]::Max($textSize.Height, 32) + 24
    $form.ClientSize = New-Object Drawing.Size($width, ($top + 52))
    $x = $width - 20
    $created = @()
    for ($i = $specs.Count - 1; $i -ge 0; $i--) {
        $btn = New-Object Windows.Forms.Button
        $btn.Text = $specs[$i][0]
        $btn.DialogResult = [Windows.Forms.DialogResult]$specs[$i][1]
        $btn.Size = New-Object Drawing.Size(92, 32)
        $x -= 92
        $btn.Location = New-Object Drawing.Point($x, $top)
        $x -= 10
        $form.Controls.Add($btn)
        $created = @($btn) + $created
    }
    $form.AcceptButton = $created[0]
    $form.CancelButton = $created[$created.Count - 1]
    $form.Add_Shown({ $this.Activate() })
    $result = $form.ShowDialog()
    $form.Dispose()
    return [string]$result
}

# 输入框的中文右键菜单（系统自带的菜单在英文 Windows 上是英文）
function Add-ChineseMenu($textBox) {
    $menu = New-Object Windows.Forms.ContextMenuStrip
    [void]$menu.Items.Add('剪切', $null, { $this.Owner.SourceControl.Cut() })
    [void]$menu.Items.Add('复制', $null, { $this.Owner.SourceControl.Copy() })
    [void]$menu.Items.Add('粘贴', $null, { $this.Owner.SourceControl.Paste() })
    [void]$menu.Items.Add('全选', $null, { $this.Owner.SourceControl.SelectAll() })
    $textBox.ContextMenuStrip = $menu
}

function Show-Info([string]$text) { [void](Show-Box $text 'OK' 'Information') }
function Show-Error([string]$text) { [void](Show-Box $text 'OK' 'Error') }
function Confirm-Choice([string]$text) { return ((Show-Box $text 'YesNo' 'Question') -eq 'Yes') }
function Confirm-Retry([string]$text) { return ((Show-Box $text 'RetryCancel' 'Warning') -eq 'Retry') }

# ---------------- 进度窗口 ----------------

function Open-ProgressWindow([string]$heading) {
    $form = New-Object Windows.Forms.Form
    $form.Text = $script:UiTitle
    $form.Font = $script:UiFont
    $form.StartPosition = 'CenterScreen'
    $form.ClientSize = New-Object Drawing.Size(600, 400)
    $form.MinimumSize = New-Object Drawing.Size(480, 320)

    $title = New-Object Windows.Forms.Label
    $title.Text = $heading
    $title.Font = New-Object Drawing.Font('Microsoft YaHei UI', 12, [Drawing.FontStyle]::Bold)
    $title.Dock = 'Top'
    $title.Height = 40
    $title.Padding = New-Object Windows.Forms.Padding(12, 10, 12, 0)

    $box = New-Object Windows.Forms.RichTextBox
    $box.ReadOnly = $true
    $box.BorderStyle = 'None'
    $box.BackColor = [Drawing.Color]::White
    $box.Dock = 'Fill'
    $box.Font = $script:UiFont
    $box.DetectUrls = $false

    $panel = New-Object Windows.Forms.Panel
    $panel.Dock = 'Fill'
    $panel.Padding = New-Object Windows.Forms.Padding(12, 4, 12, 4)
    $panel.Controls.Add($box)

    $bottom = New-Object Windows.Forms.Panel
    $bottom.Dock = 'Bottom'
    $bottom.Height = 52
    $close = New-Object Windows.Forms.Button
    $close.Text = '关闭'
    $close.Size = New-Object Drawing.Size(100, 32)
    $close.Anchor = 'Right, Bottom'
    $close.Location = New-Object Drawing.Point(486, 10)
    $close.Enabled = $false
    $close.Add_Click({ $this.FindForm().Close() })
    $bottom.Controls.Add($close)

    $form.Controls.Add($panel)
    $form.Controls.Add($bottom)
    $form.Controls.Add($title)
    # 任务进行中不能关窗口（否则后续步骤会中途失败）；完成后"关闭"按钮可用时才允许关闭
    $form.Add_FormClosing({
        if ($_.CloseReason -eq [Windows.Forms.CloseReason]::UserClosing -and $script:Progress -and !$script:Progress.Close.Enabled) {
            $_.Cancel = $true
            [void](Show-Box '正在处理中，请等待完成后再关闭窗口。' 'OK' 'Information')
        }
    })
    $form.Show()
    $form.Activate()
    [Windows.Forms.Application]::DoEvents()
    $script:Progress = [pscustomobject]@{ Form = $form; Box = $box; Close = $close; Title = $title }
}

function Write-Line([string]$text, [string]$color = 'Black') {
    if (!$script:Progress -or $script:Progress.Box.IsDisposed) { return }
    $box = $script:Progress.Box
    $box.SelectionStart = $box.TextLength
    $box.SelectionLength = 0
    $box.SelectionColor = [Drawing.Color]::FromName($color)
    $box.AppendText($text + "`r`n")
    $box.ScrollToCaret()
    [Windows.Forms.Application]::DoEvents()
}
function Write-Step([string]$text) { Write-Line $text 'SteelBlue' }
function Write-Ok([string]$text) { Write-Line ('✔ ' + $text) 'ForestGreen' }
function Write-Warn([string]$text) { Write-Line $text 'DarkOrange' }
function Write-Err([string]$text) { Write-Line ('✖ ' + $text) 'Firebrick' }

# 处理窗口消息，同时等待一段时间（不让窗口卡住）
function Wait-Ui([int]$milliseconds) {
    $until = [DateTime]::Now.AddMilliseconds($milliseconds)
    while ([DateTime]::Now -lt $until) {
        [Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 50
    }
}

# 任务结束：允许关闭窗口，并一直显示到用户关掉它
function Complete-ProgressWindow([string]$heading, [bool]$success) {
    if (!$script:Progress) { return }
    $script:Progress.Title.Text = $heading
    $script:Progress.Title.ForeColor = $(if ($success) { [Drawing.Color]::ForestGreen } else { [Drawing.Color]::Firebrick })
    $script:Progress.Close.Enabled = $true
    $script:Progress.Close.Focus()
    $form = $script:Progress.Form
    while ($form.Visible) {
        [Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 50
    }
}

# ---------------- 云电脑地址 / 密码输入框 ----------------
# 点"连接"后先检查地址，再验证密码；哪一项错了就在哪一项下面显示红字，用户改完再点连接。
# $FixedUrl 不为空时地址不可修改（只需要重新输入密码，例如密码被修改后）。
# 返回 @{ Url; Password }，用户取消时返回 $null。
function Show-CredentialDialog([string]$FixedUrl = '', [string]$Intro = '请输入云电脑的连接信息：') {
    $form = New-Object Windows.Forms.Form
    $form.Text = $script:UiTitle
    $form.Font = $script:UiFont
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.TopMost = $true
    $form.ClientSize = New-Object Drawing.Size(500, 330)

    $y = 16
    # 注意：PowerShell 变量名不区分大小写，控件变量不能叫 $intro（会覆盖参数 $Intro）
    $introLabel = New-Object Windows.Forms.Label
    $introLabel.Location = New-Object Drawing.Point(20, $y)
    $introLabel.Size = New-Object Drawing.Size(460, 44)
    $introLabel.Text = $Intro
    $form.Controls.Add($introLabel)

    $y = 64
    $urlLabel = New-Object Windows.Forms.Label
    $urlLabel.Location = New-Object Drawing.Point(20, $y)
    $urlLabel.Size = New-Object Drawing.Size(460, 22)
    $urlLabel.Text = '请输入您的云电脑连接地址（例如 https://xxxx.app）'
    $form.Controls.Add($urlLabel)
    $urlBox = New-Object Windows.Forms.TextBox
    $urlBox.Location = New-Object Drawing.Point(20, ($y + 24))
    $urlBox.Size = New-Object Drawing.Size(460, 28)
    $urlBox.MaxLength = 300
    if ($FixedUrl) { $urlBox.Text = $FixedUrl; $urlBox.ReadOnly = $true }
    Add-ChineseMenu $urlBox
    $form.Controls.Add($urlBox)
    $urlError = New-Object Windows.Forms.Label
    $urlError.Location = New-Object Drawing.Point(20, ($y + 54))
    $urlError.Size = New-Object Drawing.Size(460, 22)
    $urlError.ForeColor = [Drawing.Color]::Firebrick
    $form.Controls.Add($urlError)

    $y = 148
    $pwLabel = New-Object Windows.Forms.Label
    $pwLabel.Location = New-Object Drawing.Point(20, $y)
    $pwLabel.Size = New-Object Drawing.Size(460, 22)
    $pwLabel.Text = '旧版云电脑填写密码；新版可留空，在打开的网页中登录'
    $form.Controls.Add($pwLabel)
    $pwBox = New-Object Windows.Forms.TextBox
    $pwBox.Location = New-Object Drawing.Point(20, ($y + 24))
    $pwBox.Size = New-Object Drawing.Size(460, 28)
    $pwBox.MaxLength = 256
    $pwBox.UseSystemPasswordChar = $true
    Add-ChineseMenu $pwBox
    $form.Controls.Add($pwBox)
    $show = New-Object Windows.Forms.CheckBox
    $show.Location = New-Object Drawing.Point(20, ($y + 54))
    $show.Size = New-Object Drawing.Size(120, 24)
    $show.Text = '显示密码'
    $show.Add_CheckedChanged({ $pwBox.UseSystemPasswordChar = !$show.Checked })
    $form.Controls.Add($show)
    $pwError = New-Object Windows.Forms.Label
    $pwError.Location = New-Object Drawing.Point(20, ($y + 80))
    $pwError.Size = New-Object Drawing.Size(460, 40)
    $pwError.ForeColor = [Drawing.Color]::Firebrick
    $form.Controls.Add($pwError)

    $status = New-Object Windows.Forms.Label
    $status.Location = New-Object Drawing.Point(20, 290)
    $status.Size = New-Object Drawing.Size(250, 24)
    $status.ForeColor = [Drawing.Color]::DimGray
    $form.Controls.Add($status)

    $ok = New-Object Windows.Forms.Button
    $ok.Text = '连接'
    $ok.Location = New-Object Drawing.Point(284, 284)
    $ok.Size = New-Object Drawing.Size(92, 34)
    $form.Controls.Add($ok)
    $form.AcceptButton = $ok
    $cancel = New-Object Windows.Forms.Button
    $cancel.Text = '取消'
    $cancel.Location = New-Object Drawing.Point(388, 284)
    $cancel.Size = New-Object Drawing.Size(92, 34)
    $cancel.DialogResult = 'Cancel'
    $form.Controls.Add($cancel)
    $form.CancelButton = $cancel

    $result = @{ Value = $null }
    $setBusy = {
        param([bool]$busy, [string]$text)
        $ok.Enabled = !$busy
        $status.Text = $text
        $form.Cursor = $(if ($busy) { [Windows.Forms.Cursors]::WaitCursor } else { [Windows.Forms.Cursors]::Default })
        [Windows.Forms.Application]::DoEvents()
    }
    $ok.Add_Click({
        $urlError.Text = ''
        $pwError.Text = ''
        $pwError.ForeColor = [Drawing.Color]::Firebrick
        # 1. 地址
        try { $url = Get-NormalizedUrl $urlBox.Text } catch { $urlError.Text = $_.Exception.Message; $urlBox.Focus(); return }
        if (!$urlBox.ReadOnly) { $urlBox.Text = $url }
        # 2. 密码格式
        $pw = Get-NormalizedPassword $pwBox.Text
        $pwBox.Text = $pw.Value
        try {
            & $setBusy $true '正在检查地址...'
            $address = Test-CloudAddress $url
            if (!$address.Ok) {
                if ($address.Kind -eq 'network') { $status.Text = ''; $urlError.Text = $address.Message }
                else { $urlError.Text = '地址错误：' + $address.Message; $urlBox.Focus(); $urlBox.SelectAll() }
                return
            }
            & $setBusy $true '正在检查登录方式...'
            $mode = Get-CloudAuthMode $url
            if ($mode -eq 'shared-browser') {
                $pwBox.Clear()
                $result.Value = [pscustomobject]@{ Url = $url; Password = ''; AuthMode = $mode }
                $form.Close(); return
            }
            if (!$pw.Value) { $pwError.Text = '此旧版云电脑需要填写密码'; $pwBox.Focus(); return }
            & $setBusy $true '正在验证密码...'
            $login = Test-CloudLogin $url $pw.Value
            if ($login.Ok) { $result.Value = [pscustomobject]@{ Url = $url; Password = $pw.Value; AuthMode = $mode }; $form.Close(); return }
            switch ($login.Kind) {
                'password' {
                    $pwError.Text = '密码错误：' + $login.Message
                    if ($pw.Removed -gt 0) { $pwError.Text += "（已自动去除 $($pw.Removed) 个空格或无效字符）" }
                    $pwBox.Focus(); $pwBox.SelectAll()
                }
                'url' { $urlError.Text = '地址错误：' + $login.Message; $urlBox.Focus() }
                default { $pwError.Text = $login.Message }
            }
        } catch {
            Write-ErrorLog '验证云电脑地址和密码' $_
            $pwError.Text = Get-ChineseError $_
        } finally {
            & $setBusy $false ''
        }
    })
    $form.Add_Shown({
        $form.Activate()
        if ($FixedUrl) { $pwBox.Focus() } else { $urlBox.Focus() }
    })
    [void]$form.ShowDialog()
    $form.Dispose()
    return $result.Value
}

# 根据云电脑地址生成内部名称（只用于区分多台云电脑，用户看不到）
function Get-TargetName([string]$url) {
    $name = ([Uri]$url).Host.Split('.')[0] -replace '[^a-zA-Z0-9_-]', '-'
    if ($name.Length -gt 40) { $name = $name.Substring(0, 40) }
    if (!$name) { $name = 'cloudpc' }
    return $name
}
