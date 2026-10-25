$ErrorActionPreference='Stop'
$app=Split-Path $PSScriptRoot -Parent
. (Join-Path $app 'common.ps1')
. (Join-Path $app 'manager-targets.ps1')
$temp=Join-Path ([IO.Path]::GetTempPath()) ('cmcp-auto-save-'+[Guid]::NewGuid().ToString('N'))
$script:StateDir=$temp;$script:TargetsFile=Join-Path $temp 'cloudpc-targets.json';$script:StatusFile=Join-Path $temp 'link-status.json';$script:StopFlag=Join-Path $temp 'stopped.flag';$script:ErrorLog=Join-Path $temp 'error.log'
[void][IO.Directory]::CreateDirectory($temp)
$checks=New-Object Collections.Generic.List[string]
$events=New-Object Collections.Generic.List[object]
function Check([bool]$Ok,[string]$Name){if(!$Ok){throw $Name};$checks.Add($Name)}
function Reject([scriptblock]$Body){try{& $Body | Out-Null;return $false}catch{return $true}}
foreach($entry in @(@('manager-save.ps1','Invoke-ManagerSave'),@('start.ps1','Confirm-Targets'))){
    $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $app $entry[0]),[ref]$null,[ref]$null);$name=$entry[1]
    $fn=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name}.GetNewClosure(),$true)
    Invoke-Expression $fn.Extent.Text
}
function Send-ManagerEvent($Kind,$Message,$Name=''){$events.Add(@{kind=$Kind;message=$Message;name=$Name})}
function Test-CloudAddress {return @{Ok=$true}}
function Get-CloudAuthMode {return $script:mode}
function Test-CloudLogin {$script:logins++;return @{Ok=$true}}
function Write-Step{};function Write-Ok{}
$script:mode='shared-browser';$script:logins=0
$secret='测试 密码 A1 '' $() \'
try{
    Save-CloudTarget 'B' 'https://b.invalid' '' 'shared-browser';$null=Set-TargetConnection 'B' $true
    $switches=[IO.File]::ReadAllText((Join-Path $temp 'target-controls.json'))
    Check (Invoke-ManagerSave @{action='add';url='https://a.invalid';password=$secret;autoLogin=$true}) 'explicit checked shared save succeeds'
    $a=@(Get-CloudTargets | Where-Object url -eq 'https://a.invalid')[0];$name=$a.name
    Check ($a.autoLogin -eq $true -and $a.password -and (Unprotect-Text $a.password) -ceq $secret) 'shared password preserves exact Unicode and is account DPAPI encrypted'
    Check (!([IO.File]::ReadAllText($TargetsFile).Contains($secret))) 'plaintext password never appears in saved JSON'
    Check ($script:logins -eq 0) 'saving shared auto credentials never submits password to remote login'
    Check ([IO.File]::ReadAllText((Join-Path $temp 'target-controls.json')) -ceq $switches) 'saving auto mode leaves B switch and all enables unchanged'
    Check (Invoke-ManagerSave @{action='edit';name=$name;url='https://a.invalid';password='';autoLogin=$true}) 'blank password preserves saved secret for same target origin'
    $a=@(Get-CloudTargets | Where-Object name -eq $name)[0]
    Check ((Unprotect-Text $a.password) -ceq $secret) 'preserved secret is not normalized or replaced with blank'
    $before=[IO.File]::ReadAllText($TargetsFile)
    Check (!(Invoke-ManagerSave @{action='edit';name=$name;url='https://new.invalid';password='';autoLogin=$true})) 'changing origin never reuses saved password'
    Check ([IO.File]::ReadAllText($TargetsFile) -ceq $before) 'rejected changed origin preserves original bytes'
    $script:TargetName=$name;$cipher=$a.password
    $null=Confirm-Targets
    Check (@(Get-CloudTargets | Where-Object name -eq $name)[0].password -ceq $cipher) 'production selected start does not erase checked shared credentials'
    Check (Invoke-ManagerSave @{action='edit';name=$name;url='https://a.invalid';password='';autoLogin=$false}) 'unchecking returns target to manual shared login'
    $a=@(Get-CloudTargets | Where-Object name -eq $name)[0]
    Check (!$a.password -and $a.autoLogin -eq $false) 'unchecking removes shared saved ciphertext'
    Check (!(Invoke-ManagerSave @{action='add';url='https://empty.invalid';password='';autoLogin=$true})) 'automatic login cannot be enabled with no saved secret'
    Check (Reject {Invoke-ManagerSave @{action='add';url='https://type.invalid';password=$secret;autoLogin='true'}}) 'nonboolean auto option is rejected'
    $script:mode='legacy'
    Check (!(Invoke-ManagerSave @{action='add';url='https://legacy.invalid';password=$secret;autoLogin=$true})) 'shared auto option cannot force legacy protocol or submit password'
    Check ($script:logins -eq 0 -and !(($events|ConvertTo-Json -Depth 4).Contains($secret))) 'save failures neither login nor leak secret into progress'
    $fixture=Join-Path $temp 'worker-app';[void][IO.Directory]::CreateDirectory($fixture)
    foreach($file in @('manager-save.ps1','manager-targets.ps1','manager-events.ps1')){Copy-Item -LiteralPath (Join-Path $app $file) -Destination (Join-Path $fixture $file)}
    $common=". '"+(Join-Path $app 'common.ps1').Replace("'","''")+"'`r`n"+'$script:StateDir=Split-Path $PSScriptRoot -Parent;$script:TargetsFile=Join-Path $StateDir "cloudpc-targets.json";$script:ErrorLog=Join-Path $StateDir "error.log";function Initialize-StateDir {}'
    [IO.File]::WriteAllText((Join-Path $fixture 'common.ps1'),$common,[Text.UTF8Encoding]::new($true))
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=Join-Path $PSHOME 'powershell.exe';$info.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $fixture 'manager-save.ps1')+'"'
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $child=New-Object Diagnostics.Process;$child.StartInfo=$info
    try{
        $null=$child.Start();$child.StandardInput.WriteLine('{"password":"SECRET-TEST-MARKER"');$child.StandardInput.Close()
        if(!$child.WaitForExit(15000)){$child.Kill();throw 'Malformed-input fixture timed out'}
        $out=$child.StandardOutput.ReadToEnd();$err=$child.StandardError.ReadToEnd()
        Check ($child.ExitCode -eq 1 -and $out -match 'schema') 'real save worker reports malformed stdin as a bounded failure'
        Check (!([IO.File]::ReadAllText($ErrorLog).Contains('SECRET-TEST-MARKER')) -and !$out.Contains('SECRET-TEST-MARKER') -and !$err.Contains('SECRET-TEST-MARKER')) 'parser error cannot log or display a password from malformed stdin'
    }finally{$child.Dispose()}
    [pscustomobject]@{passed=$checks.Count;failed=0;skipped=0;checks=@($checks)}|ConvertTo-Json -Depth 4
}catch{[pscustomobject]@{passed=$checks.Count;failed=1;skipped=0;error=$_.Exception.Message;checks=@($checks)}|ConvertTo-Json -Depth 4;exit 1}
finally{if($fixture -and [IO.Directory]::Exists($fixture)){foreach($name in @('manager-save.ps1','manager-targets.ps1','manager-events.ps1','common.ps1')){[IO.File]::Delete((Join-Path $fixture $name))};[IO.Directory]::Delete($fixture,$false)};foreach($name in @('cloudpc-targets.json','target-controls.json','control-order.txt','link-status.json','error.log')){[IO.File]::Delete((Join-Path $temp $name))};[IO.Directory]::Delete($temp,$false)}
