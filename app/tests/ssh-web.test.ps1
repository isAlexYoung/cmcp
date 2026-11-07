$ErrorActionPreference='Stop'
$temporary=Join-Path ([IO.Path]::GetTempPath()) ('cmcp-ssh-web-'+[guid]::NewGuid().ToString('N'))
$previous=$env:CMCP_STATE_DIR;$env:CMCP_STATE_DIR=$temporary
$checks=New-Object 'Collections.Generic.List[string]'
function Check($ok,$name){if(!$ok){throw $name};$checks.Add($name)}
try{
    . (Join-Path $PSScriptRoot '../common.ps1')
    . (Join-Path $PSScriptRoot '../target-controls.ps1')
    $null=New-Item -ItemType Directory -Path $temporary
    Write-Utf8File (Join-Path $temporary 'ssh-logins.json') (@{schema=1;logins=@(@{name='device';host='example.test';port=22;username='user';method='password';webTunnel=$true;webPort=3000;webAutoLogin=$true;webSecret=(Protect-Text 'WEB-TEST-ONLY');cloudcliTunnel=$true;cloudcliPort=3001;cloudcliAutoLogin=$false;cloudcliSecret=''})}|ConvertTo-Json -Depth 5)
    $targets=@(Get-ConnectionTargets)
    Check ($targets.Count -eq 2) 'SSH web profiles work without a saved URL or CloudCLI file'
    $web=@($targets|Where-Object name -eq 'tunnel:web:device')[0];$cloud=@($targets|Where-Object name -eq 'tunnel:cloudcli:device')[0]
    Check ($web.url -eq 'http://127.0.0.1:3000' -and $cloud.url -eq 'http://127.0.0.1:3001') 'both services retain their independent remote ports'
    Check ((Unprotect-Text $web.password) -ceq 'WEB-TEST-ONLY' -and !$cloud.password -and !$cloud.autoLogin) 'only the selected service supplies its web password'
    $null=Set-TargetConnection 'tunnel:web:device' $true
    Check (@((Get-TargetControls).targets|Where-Object enabled).Count -eq 1) 'starting a webpage never starts the other service'
    $null=Set-TargetConnection '' $false -All
    Check (@((Get-TargetControls).targets|Where-Object enabled).Count -eq 0) 'full exit disables both SSH webpages'
    Write-Utf8File (Join-Path $temporary 'application-preferences.json') '{"schema":1,"browser":"edge","cloudcliBrowser":"chrome"}'
    function Find-BrowserProgram([string]$id){return ('C:\fixture\'+$id+'.exe')}
    Check ((Get-BrowserChoice 'tunnel:cloudcli:device').Id -eq 'chrome' -and (Get-BrowserChoice 'tunnel:web:device').Id -eq 'edge') 'SSH webpages reuse the selected applications browser preferences'
    @{passed=$checks.Count;failed=0;checks=@($checks)}|ConvertTo-Json -Depth 4
}finally{
    $env:CMCP_STATE_DIR=$previous
    $full=[IO.Path]::GetFullPath($temporary);$base=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if($full.StartsWith($base,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($full) -match '^cmcp-ssh-web-[a-f0-9]{32}$'){Remove-Item -LiteralPath $full -Recurse -Force}
}
