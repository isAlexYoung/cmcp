$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'common.ps1')
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'manager-targets.ps1')
$temp = Join-Path ([IO.Path]::GetTempPath()) ('cmcp-ui-targets-' + [Guid]::NewGuid().ToString('N'))
$script:StateDir = $temp
$script:TargetsFile = Join-Path $temp 'cloudpc-targets.json'
$script:StatusFile = Join-Path $temp 'link-status.json'
$script:StopFlag = Join-Path $temp 'stopped.flag'
$checks = New-Object Collections.Generic.List[string]
function Check([bool]$ok, [string]$name) { if (!$ok) { throw $name }; $checks.Add($name) }
function Rejected([scriptblock]$body) { try { & $body; return $false } catch { return $true } }
try {
    [void][IO.Directory]::CreateDirectory($temp)
    $targets = @([pscustomobject]@{name='A';url='https://a.invalid';password=$null;authMode='shared-browser'},[pscustomobject]@{name='B';url='https://b.invalid';password=$null;authMode='shared-browser'})
    Write-TargetStateFile $TargetsFile (ConvertTo-Json -InputObject $targets -Depth 5)
    $null = Set-TargetConnection 'B' $true
    $switches = [IO.File]::ReadAllText((Join-Path $temp 'target-controls.json'))
    Update-ManagerCloudTarget 'A' 'https://new-a.invalid' '' 'shared-browser'
    $saved = @(Get-CloudTargets)
    Check ($saved[0].name -ceq 'A' -and $saved[0].url -eq 'https://new-a.invalid') 'address edit preserves immutable A identity'
    Check ($saved[1].name -ceq 'B' -and $saved[1].url -eq 'https://b.invalid') 'address edit preserves B data and order'
    Check ([IO.File]::ReadAllText((Join-Path $temp 'target-controls.json')) -ceq $switches) 'editing A never changes B connection switches'
    $before = [IO.File]::ReadAllText($TargetsFile)
    Check (Rejected { Update-ManagerCloudTarget 'A' 'https://b.invalid' '' 'shared-browser' }) 'duplicate address cannot overwrite another card'
    Check (Rejected { Update-ManagerCloudTarget 'missing' 'https://other.invalid' '' 'shared-browser' }) 'editing unknown card cannot create a target'
    Check (Rejected { Update-ManagerCloudTarget 'B' 'https://other.invalid' '' 'shared-browser' }) 'enabled B cannot be edited behind running connection'
    Check (Rejected { Remove-ManagerCloudTarget 'B' }) 'enabled B cannot be removed without confirmed stop'
    Check (Rejected { Remove-ManagerCloudTarget '' }) 'empty delete cannot become delete-all'
    Check ([IO.File]::ReadAllText($TargetsFile) -ceq $before) 'all rejected edits preserve target bytes'
    Write-TargetStateFile $StatusFile (@{pid=$PID;targets=@{A=@{state='connected'}}} | ConvertTo-Json -Depth 5)
    Check (Rejected { Remove-ManagerCloudTarget 'A' }) 'backend active status blocks deletion even with disabled desired state'
    Write-TargetStateFile $StatusFile (@{pid=$PID;targets=@{A=@{state='stopped'}}} | ConvertTo-Json -Depth 5)
    Remove-ManagerCloudTarget 'A'
    Check (@(Get-CloudTargets).Count -eq 1 -and @(Get-CloudTargets)[0].name -ceq 'B') 'confirmed stopped A removal leaves B intact'
    Check ([IO.File]::ReadAllText((Join-Path $temp 'target-controls.json')) -ceq $switches) 'removal never disables B'
    Check (!(Test-Path -LiteralPath $StopFlag)) 'manager edits never set global stop flag'
    [IO.File]::Delete($StatusFile)
    $null = Set-TargetConnection 'B' $false
    Remove-ManagerCloudTarget 'B'
    Check (@(Get-CloudTargets).Count -eq 0) 'last stopped card removal stores empty array'
    Check (Rejected { Remove-ManagerCloudTarget 'B' }) 'repeat deletion refuses unknown identity'
    Write-TargetStateFile $TargetsFile (ConvertTo-Json -InputObject $targets -Depth 5)
    Write-TargetStateFile (Join-Path $temp 'target-controls.json') '{'
    Check (Rejected { Update-ManagerCloudTarget 'A' 'https://new.invalid' '' 'shared-browser' }) 'corrupt controls block address mutation'
    Check (Rejected { Remove-ManagerCloudTarget 'A' }) 'corrupt controls block deletion'
    [IO.File]::Delete((Join-Path $temp 'target-controls.json'))
    Update-ManagerCloudTarget 'A' 'https://a.invalid' 'TEST-ONLY-NOT-A-REAL-PASSWORD' 'legacy'
    $cipher = @(Get-CloudTargets | Where-Object name -eq 'A')[0].password
    Check ($cipher -and $cipher -notmatch 'TEST-ONLY') 'legacy credentials continue to use current-user DPAPI'
    $uiSource = [IO.File]::ReadAllText((Join-Path (Split-Path $PSScriptRoot -Parent) 'ui.ps1'))
    Check ($uiSource.Contains('[string]$InitialUrl') -and $uiSource.Contains('$urlBox.Text = $InitialUrl')) 'existing login dialog supports editable prefill without fixed URL downgrade'
    [pscustomobject]@{passed=$checks.Count;failed=0;skipped=0;not_executed=@('real VPS edit and remove');checks=@($checks)} | ConvertTo-Json -Depth 4
} catch {
    [pscustomobject]@{passed=$checks.Count;failed=1;skipped=0;error=$_.Exception.Message;checks=@($checks)} | ConvertTo-Json -Depth 4
    exit 1
} finally {
    foreach ($file in @('cloudpc-targets.json','link-status.json','target-controls.json')) { if ([IO.File]::Exists((Join-Path $temp $file))) { [IO.File]::Delete((Join-Path $temp $file)) } }
    if ([IO.Directory]::Exists($temp)) { [IO.Directory]::Delete($temp,$false) }
}
