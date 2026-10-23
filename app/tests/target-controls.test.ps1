param([string]$StateDirectory = '', [string]$WorkerName = '')
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'common.ps1')
if ($WorkerName) {
    $script:StateDir = $StateDirectory
    $script:TargetsFile = Join-Path $StateDirectory 'cloudpc-targets.json'
    $script:StopFlag = Join-Path $StateDirectory 'stopped.flag'
    $script:StatusFile = Join-Path $StateDirectory 'link-status.json'
    for ($i = 0; $i -lt 12; $i++) { $null = Set-TargetConnection $WorkerName ($i % 2 -eq 1) }
    exit 0
}
$temp = Join-Path ([IO.Path]::GetTempPath()) ('mcp-target-controls-' + [Guid]::NewGuid().ToString('N'))
$script:StateDir = $temp
$script:TargetsFile = Join-Path $temp 'cloudpc-targets.json'
$script:StopFlag = Join-Path $temp 'stopped.flag'
$script:StatusFile = Join-Path $temp 'link-status.json'
$checks = New-Object Collections.Generic.List[string]
function Check([bool]$ok, [string]$name) { if (!$ok) { throw $name }; $checks.Add($name) }
function Enabled([string]$name) { return [bool](@((Get-TargetControls).targets | Where-Object { $_.name -ceq $name })[0].enabled) }
try {
    [void][IO.Directory]::CreateDirectory($temp)
    $targets = @([pscustomobject]@{ name = 'A'; url = 'https://a.invalid'; authMode = 'shared-browser'; password = $null }, [pscustomobject]@{ name = 'B'; url = 'https://b.invalid'; authMode = 'shared-browser'; password = $null })
    Write-Utf8File $TargetsFile (ConvertTo-Json -InputObject $targets)
    $a = Set-TargetConnection 'A' $true
    Check ((Enabled 'A') -and !(Enabled 'B')) 'first selected start enables A only'
    $b = Set-TargetConnection 'B' $true
    Check ((Enabled 'A') -and (Enabled 'B')) 'starting B preserves enabled A'
    $null = Set-TargetConnection 'A' $false
    Check (!(Enabled 'A') -and (Enabled 'B')) 'stopping A preserves enabled B'
    $saved = Get-TargetControls
    $null = Set-TargetConnection 'B' $true
    Check ($b.revision -eq @((Get-TargetControls).targets | Where-Object name -eq 'B')[0].revision) 'starting connected target is idempotent'
    Write-Utf8File $StatusFile (ConvertTo-Json -InputObject @{pid=$PID;controlProtocol=1;targets=@{B=@{state='replaced';revision=$b.revision}}} -Depth 5)
    $retryB = Set-TargetConnection 'B' $true
    Check ($retryB.revision -ne $b.revision) 'explicit start can recover a taken-over target'
    [IO.File]::Delete($StatusFile)
    $newer = [DateTime]::UtcNow.Ticks
    $null = Set-TargetConnection 'A' $false -RequestTime $newer
    $rejected = $false
    try { $null = Set-TargetConnection 'A' $true -RequestTime ($newer - 100) } catch { $rejected = $true }
    Check ($rejected -and !(Enabled 'A')) 'delayed start cannot override a newer stop'
    Save-CloudTarget 'B' 'https://b.invalid' '' 'shared-browser'
    Check ((Enabled 'B') -and !(Enabled 'A')) 'editing saved target leaves both switches unchanged'
    Save-CloudTarget 'new' 'https://new.invalid' '' 'shared-browser'
    Check (@((Get-TargetControls).targets | Where-Object name -eq 'new').Count -eq 0) 'newly added target is not implicitly enabled'
    $unknown = $false; try { $null = Set-TargetConnection 'missing' $true } catch { $unknown = $true }
    Check $unknown 'unknown target rejected'
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $workers = @()
    foreach ($name in @('A','B')) {
        $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -StateDirectory "' + $temp + '" -WorkerName ' + $name
        $workers += Start-Process $ps -ArgumentList $arguments -WindowStyle Hidden -PassThru
    }
    foreach ($p in $workers) { $p.WaitForExit(); Check ($p.ExitCode -eq 0) 'concurrent Windows PowerShell writer completes'; $p.Dispose() }
    Check ((Enabled 'A') -and (Enabled 'B')) 'concurrent target updates do not lose other target changes'
    $null = Set-TargetConnection '' $false -All
    $null = Set-TargetConnection 'A' $true
    Check ((Enabled 'A') -and !(Enabled 'B')) 'selected start after explicit stop-all does not re-enable B'
    Check (!(Test-Path -LiteralPath $StopFlag)) 'target actions never write the global stop flag'
    Write-Utf8File $StatusFile (@{ pid = $PID; targets = @{} } | ConvertTo-Json)
    $old = $false; try { Assert-TargetControlSupport } catch { $old = $true }
    Check $old 'old running backend is rejected without terminating it'
    $controlFile = Join-Path $temp 'target-controls.json'
    Write-Utf8File $controlFile '{'
    $bad = $false; try { $null = Set-TargetConnection 'A' $true } catch { $bad = $true }
    Check ($bad -and [IO.File]::ReadAllText($controlFile) -eq '{') 'corrupt preferences are not overwritten'
    # Extract actual production functions, without executing the UI/main routine.
    $source = Join-Path (Split-Path $PSScriptRoot -Parent) 'start.ps1'
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
    foreach ($name in @('Confirm-Targets','Start-Background','Wait-Connected')) {
        $fn = $ast.Find({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq $name }.GetNewClosure(),$true)
        Invoke-Expression $fn.Extent.Text
    }
    # These mocks prohibit all global operations, while the real selected branch runs.
    function Stop-LinkService { throw 'selected start must never stop the backend' }
    function Remove-LegacyFiles { throw 'selected start must never delete global state' }
    function Register-AutoStart { return 'test-only' }
    function Start-LinkService { $script:Starts++ }
    function Write-Step { param($s) }
    function Write-Ok { param($s) }
    function Write-Line { param($s,$color) }
    function Write-Warn { param($s) }
    function Assert-TargetControlSupport {}
    [IO.File]::Delete($controlFile)
    $script:TargetName = 'A'; $script:Control = Set-TargetConnection 'A' $true; $script:Starts = 0
    $selected = @(Confirm-Targets)
    Check ($selected.Count -eq 1 -and $selected[0].name -eq 'A') 'production start checks selected target only'
    Start-Background
    Check ($script:Starts -eq 1 -and (Test-Path -LiteralPath $StatusFile)) 'production start reuses backend and preserves status'
    $null = Set-TargetConnection 'A' $false
    $cancelled = $false; try { Start-Background } catch { $cancelled = $true }
    Check ($cancelled -and $script:Starts -eq 1) 'stop during startup prevents a late backend start'
    # Running actual selected stop in a separate process must never reach global stop.
    $null = Set-TargetConnection 'B' $true
    [IO.File]::Delete($StatusFile)
    $fixtureApp = Join-Path $temp 'fixture-app'
    [void][IO.Directory]::CreateDirectory($fixtureApp)
    $stopSource = [IO.File]::ReadAllText((Join-Path (Split-Path $PSScriptRoot -Parent) 'stop.ps1'))
    [IO.File]::WriteAllText((Join-Path $fixtureApp 'stop.ps1'),$stopSource,[Text.UTF8Encoding]::new($true))
    $fixtureCommon = '$script:StateDir = Split-Path $PSScriptRoot -Parent; $script:StopFlag = Join-Path $StateDir "stopped.flag"; $script:StatusFile = Join-Path $StateDir "link-status.json"; $script:TargetsFile = Join-Path $StateDir "cloudpc-targets.json"' + "`r`n" +
        'function Initialize-StateDir {}; function Assert-TargetControlSupport {}; function Unregister-AutoStart { throw "GLOBAL stop reached" }; function Stop-LinkService { throw "GLOBAL stop reached" }; function Get-LinkStatus { return $null }' + "`r`n" +
        'function Get-CloudTargets { return @([pscustomobject]@{name="A"},[pscustomobject]@{name="B"}) }; function Read-JsonFile($path) { if(Test-Path -LiteralPath $path){[IO.File]::ReadAllText($path) | ConvertFrom-Json} }' + "`r`n" +
        '. "' + (Join-Path (Split-Path $PSScriptRoot -Parent) 'target-controls.ps1') + '"'
    [IO.File]::WriteAllText((Join-Path $fixtureApp 'common.ps1'),$fixtureCommon,[Text.UTF8Encoding]::new($true))
    [IO.File]::WriteAllText((Join-Path $fixtureApp 'ui.ps1'),'function Show-Error { param($s) throw $s }; function Write-ErrorLog {}',[Text.UTF8Encoding]::new($true))
    $p = Start-Process $ps -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $fixtureApp 'stop.ps1') + '" -TargetName A') -WindowStyle Hidden -Wait -PassThru
    Check ($p.ExitCode -eq 0 -and !(Enabled 'A') -and (Enabled 'B') -and !(Test-Path -LiteralPath $StopFlag)) 'production stop targets A without global shutdown or autostart removal'; $p.Dispose()
    [pscustomobject]@{passed=$checks.Count;failed=0;skipped=0;checks=@($checks)} | ConvertTo-Json -Depth 4
} finally {
    foreach ($file in @('cloudpc-targets.json','cloudpc-targets.json.tmp','target-controls.json','target-controls.json.tmp','link-status.json')) { [IO.File]::Delete((Join-Path $temp $file)) }
    $fixtureApp = Join-Path $temp 'fixture-app'
    if ([IO.Directory]::Exists($fixtureApp)) { foreach ($file in @('stop.ps1','common.ps1','ui.ps1')) { [IO.File]::Delete((Join-Path $fixtureApp $file)) } }
    if ([IO.Directory]::Exists($fixtureApp)) { [IO.Directory]::Delete($fixtureApp,$false) }
    [IO.Directory]::Delete($temp,$false)
}
