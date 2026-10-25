# Current-account Run key is never used: all registration writes target a fresh test key.
$ErrorActionPreference='Stop'
$app=Split-Path $PSScriptRoot -Parent
$originalLocal=$env:LOCALAPPDATA
$temporary=Join-Path ([IO.Path]::GetTempPath()) ('cmcp-startup-fixture-'+[guid]::NewGuid().ToString('N'))
$registry='HKCU:\Software\CMCP-StartupFixture-'+[guid]::NewGuid().ToString('N')
$checks=New-Object 'Collections.Generic.List[string]'
function Check([bool]$Value,[string]$Name){if(!$Value){throw $Name};$checks.Add($Name)}
try{
    $env:LOCALAPPDATA=$temporary;. (Join-Path $app 'common.ps1')
    $script:StateDir=Join-Path $temporary 'state'
    $script:RunKey=$registry;$script:StartupLink='';$script:KitDir=Join-Path $temporary 'kit\app'
    $null=New-Item -ItemType Directory -Path $script:KitDir -Force;$null=New-Item -ItemType Directory -Path $script:StateDir -Force
    $manager=Join-Path (Split-Path $script:KitDir -Parent) 'CMCP.exe';[IO.File]::WriteAllText($manager,'fixture, never executed')
    $preferences=Join-Path $script:StateDir 'application-preferences.json'
    [IO.File]::WriteAllText($preferences,'{"schema":1,"autoStart":false}')
    $null=New-Item -Path $registry
    New-ItemProperty -LiteralPath $registry -Name $script:RunName -Value 'fixture run-service.ps1' -PropertyType String |Out-Null
    Check ((Register-AutoStart) -eq 'disabled') 'disabled preference survives subsequent connection registration'
    Check ($null -eq (Get-ItemProperty -LiteralPath $registry).ClaudeCloudPcLink) 'disabled preference removes legacy backend registration'
    [IO.File]::WriteAllText($preferences,'{"schema":1,"autoStart":true}')
    Check ((Register-AutoStart) -eq 'manager') 'enabled preference registers current manager instead of old backend'
    Check ((Get-ItemPropertyValue -LiteralPath $registry -Name 'CMCPManager') -ceq ('"'+$manager+'" --startup')) 'automatic manager uses quoted path and hidden-to-tray startup flag'
    [IO.File]::WriteAllText($preferences,'{"schema":1,"autoStart":"false"}')
    Check ((Register-AutoStart) -eq 'none') 'corrupt startup preference cannot fall back to enabling backend'
    Check (!(Test-Path -LiteralPath (Join-Path $StateDir 'cloudpc-targets.json'))) 'startup preference test never creates a real connection'
    [pscustomobject]@{passed=$checks.Count;failed=0;skipped=0;checks=$checks}|ConvertTo-Json
}finally{
    $env:LOCALAPPDATA=$originalLocal
    if(Test-Path -LiteralPath $registry){Remove-Item -LiteralPath $registry -Recurse -Force}
    $resolved=[IO.Path]::GetFullPath($temporary);$parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if($resolved.StartsWith($parent,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -match '^cmcp-startup-fixture-[a-f0-9]{32}$' -and (Test-Path -LiteralPath $resolved)){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
