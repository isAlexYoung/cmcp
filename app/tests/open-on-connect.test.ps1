$ErrorActionPreference = 'Stop'
# Runs the real Wait-Connected from start.ps1 against a scripted backend status.
$checks = [Collections.Generic.List[string]]::new()
function Check([bool]$ok, [string]$name) { if (!$ok) { throw $name }; $checks.Add($name) }
$source = Join-Path (Split-Path $PSScriptRoot -Parent) 'start.ps1'
$ast = [Management.Automation.Language.Parser]::ParseFile($source,[ref]$null,[ref]$null)
$fn = $ast.Find({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'Wait-Connected' },$true)
Invoke-Expression $fn.Extent.Text
$TargetName = ''
$StatusFile = Join-Path ([IO.Path]::GetTempPath()) ('cmcp-open-on-connect-' + [Guid]::NewGuid().ToString('N') + '.json')
function Write-Step { param($s) }
function Write-Ok { param($s) }
function Write-Line { param($s,$color) }
function Write-Warn { param($s) }
function Wait-Ui { param($ms) Start-Sleep -Milliseconds 20 }
function Get-LinkStatus {
    $state = $script:States[[Math]::Min($script:Polls, $script:States.Count - 1)]
    $script:Polls++
    return [pscustomobject]@{ pid = $PID; targets = [pscustomobject]@{ A = [pscustomobject]@{ state = $state; message = ''; revision = 0 } } }
}
# The page entry appears only after EntryAfter failed attempts.
function Open-SharedCloudBrowser([string]$name = '') {
    $script:OpenCalls++
    if ($script:OpenCalls -gt $script:EntryAfter) { $script:Opened++; return $true }
    return $false
}
function Run([string]$authMode, [string[]]$states, [int]$entryAfter) {
    $script:States = $states; $script:Polls = 0; $script:OpenCalls = 0; $script:Opened = 0; $script:EntryAfter = $entryAfter
    Wait-Connected @([pscustomobject]@{ name = 'A'; authMode = $authMode })
}

Run 'cloudcli' @('connected') 0
Check ($script:Opened -eq 1) 'a ClaudeWeb card opens its page once it is connected'
Run 'cloudcli' @('connecting', 'connected') 2
Check ($script:Opened -eq 1 -and $script:OpenCalls -eq 3) 'connect waits for the page entry and then opens it once'
Run 'cloudcli' @('waiting-login', 'connected') 0
Check ($script:Opened -eq 1) 'a page opened for a browser sign-in is not opened again'
Run 'shared-browser' @('connected') 0
Check ($script:Opened -eq 0) 'a web desktop card that signed in without a browser is left as it was'
$timer = [Diagnostics.Stopwatch]::StartNew()
Run 'cloudcli' @('connected') 100000
Check ($script:Opened -eq 0 -and $timer.Elapsed.TotalSeconds -ge 14 -and $timer.Elapsed.TotalSeconds -lt 60) 'a page entry that never appears does not hold the connection'
[pscustomobject]@{ passed = $checks.Count; failed = 0; skipped = 0; checks = @($checks) } | ConvertTo-Json -Depth 4
