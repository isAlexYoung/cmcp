$ErrorActionPreference='Stop'
$fixtureRoot=[IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('cmcp-cloudcli-'+[guid]::NewGuid().ToString('N'))))
$previousState=$env:CMCP_STATE_DIR;$env:CMCP_STATE_DIR=$fixtureRoot
$checks=New-Object 'Collections.Generic.List[string]'
function Check([bool]$Ok,[string]$Label){if(!$Ok){throw $Label};$checks.Add($Label)}
try{
    . (Join-Path $PSScriptRoot '../common.ps1')
    . (Join-Path $PSScriptRoot '../target-controls.ps1')
    $null=New-Item -ItemType Directory -Path $fixtureRoot
    Write-Utf8File $script:TargetsFile (ConvertTo-Json -InputObject @([pscustomobject]@{name='device';url='https://desktop.example.com';authMode='shared-browser';autoLogin=$false}))
    $cipher=Protect-Text 'CLOUDCLI-TEST-SECRET'
    Write-Utf8File (Join-Path $fixtureRoot 'cloudcli-logins.json') (@{schema=1;logins=@(@{name='device';url='https://desktop-claude.example.com';secret=$cipher;autoLogin=$true})}|ConvertTo-Json -Depth 6)
    $targets=@(Get-ConnectionTargets)
    Check ($targets.Count -eq 2) 'desktop and CloudCLI expand into two independent connection profiles'
    $cloud=@($targets|Where-Object name -eq 'cloudcli:device')[0]
    Check ($cloud.authMode -eq 'cloudcli' -and $cloud.autoLogin) 'CloudCLI keeps its own protocol and automatic sign-in choice'
    Check ((Unprotect-Text $cloud.password) -ceq 'CLOUDCLI-TEST-SECRET') 'the password helper can decrypt a CloudCLI current-user credential'
    $null=Set-TargetConnection 'cloudcli:device' $true
    $controls=@((Get-TargetControls).targets)
    Check (@($controls|Where-Object { $_.name -ceq 'cloudcli:device' -and $_.enabled }).Count -eq 1 -and @($controls|Where-Object { $_.name -ceq 'device' -and $_.enabled }).Count -eq 0) 'starting CloudCLI leaves the desktop switch alone'
    $null=Set-TargetConnection '' $false -All
    Check (@((Get-TargetControls).targets|Where-Object enabled).Count -eq 0) 'full exit disables CloudCLI as well as the desktop'
    Check (@(Get-CloudTargets).Count -eq 1) 'CloudCLI never enters or overwrites the saved desktop list'
    Write-Utf8File (Join-Path $fixtureRoot 'application-preferences.json') (@{schema=1;browser='edge';closeWeb=$false;cloudcliBrowser='chrome';closeCloudcli=$true}|ConvertTo-Json)
    function Find-BrowserProgram([string]$id){return ('C:\fixture\'+$id+'.exe')}
    $web=Get-BrowserChoice 'device';$cli=Get-BrowserChoice 'cloudcli:device'
    Check ($web.Id -eq 'edge' -and !$web.Close -and $cli.Id -eq 'chrome' -and $cli.Close) 'CloudCLI browser and closing settings stay separate from desktop settings'
    Check (!(Get-Content -LiteralPath (Join-Path $fixtureRoot 'cloudcli-logins.json') -Raw).Contains('CLOUDCLI-TEST-SECRET')) 'CloudCLI configuration never contains the plaintext password'
    @{passed=$checks.Count;failed=0;checks=@($checks)}|ConvertTo-Json -Depth 4
}finally{
    $env:CMCP_STATE_DIR=$previousState
    $tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if(!$fixtureRoot.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($fixtureRoot) -notmatch '^cmcp-cloudcli-[a-f0-9]{32}$'){throw 'Unsafe fixture cleanup path'}
    if(Test-Path -LiteralPath $fixtureRoot){Remove-Item -LiteralPath $fixtureRoot -Recurse -Force}
}
