$ErrorActionPreference='Stop'
$temporary=Join-Path ([IO.Path]::GetTempPath()) ('cmcp-browser-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $temporary
$env:CMCP_STATE_DIR=Join-Path $temporary 'user'
$null=New-Item -ItemType Directory -Path $env:CMCP_STATE_DIR
$app=Split-Path $PSScriptRoot -Parent
. (Join-Path $app 'common.ps1')
$checks=New-Object Collections.Generic.List[string]
function Check($ok,$name){if(!$ok){throw $name};$checks.Add($name)}
function Settings($text){[IO.File]::WriteAllText((Join-Path $script:StateDir 'application-preferences.json'),$text,[Text.UTF8Encoding]::new($false))}
# Stand-ins: no real browser opens, and the program paths are fixed.
$script:started=$null
function Start-Process{param([string]$FilePath,$ArgumentList)$script:started=[pscustomobject]@{FilePath=$FilePath;ArgumentList=@($ArgumentList)}}
function Find-BrowserProgram([string]$id){return 'C:\fixture\'+$id+'.exe'}
$fakes=@()
try{
    $url='http://127.0.0.1:47123/__mcp/open#'+('a'*43)
    $folder=Get-CloudPageFolder "dev'ice" 'chrome'
    Check ($folder -eq (Get-CloudPageFolder "dev'ice" 'chrome') -and $folder -ne (Get-CloudPageFolder 'other' 'chrome') -and $folder.StartsWith((Join-Path $script:StateDir 'browser-windows'))) 'each device has one fixed page folder inside the state folder'
    Open-CloudPage "dev'ice" $url
    Check ($script:started.FilePath -eq $url) 'without a chosen browser the page opens in the system default browser'
    Settings '{"schema":1,"browser":"edge","closeWeb":false}'
    Open-CloudPage "dev'ice" $url
    Check ($script:started.FilePath -eq 'C:\fixture\edge.exe' -and ($script:started.ArgumentList -join ' ') -eq ('"'+$url+'"')) 'a chosen browser opens the page in its usual profile when it need not close'
    Settings '{"schema":1,"browser":"chrome","closeWeb":true}'
    Open-CloudPage "dev'ice" $url
    $line=$script:started.ArgumentList -join ' '
    Check ($script:started.FilePath -eq 'C:\fixture\chrome.exe' -and $line.Contains('--user-data-dir="'+$folder+'"') -and $line.Contains('--new-window') -and $line.EndsWith('"'+$url+'"') -and (Test-Path -LiteralPath $folder -PathType Container)) 'a page that closes on disconnect gets a browser profile of its own'
    Settings '{"schema":1,"browser":"firefox","closeWeb":true}'
    Open-CloudPage "dev'ice" $url
    Check (($script:started.ArgumentList -join ' ').Contains('-profile "'+(Get-CloudPageFolder "dev'ice" 'firefox')+'"')) 'Firefox gets its own profile the same way'
    Settings '{"schema":1,"browser":"netscape","closeWeb":true}'
    Open-CloudPage "dev'ice" $url
    Check ($script:started.FilePath -eq $url -and (Close-CloudPage "dev'ice") -eq 0) 'an unknown browser falls back to the system default and closes nothing'
    # Real processes named chrome.exe whose command lines carry a page folder.
    $fake=Join-Path $temporary 'chrome.exe';Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\cmd.exe') -Destination $fake
    $other=Get-CloudPageFolder 'other' 'chrome'
    foreach($target in @($folder,$other)){$fakes+=Microsoft.PowerShell.Management\Start-Process -FilePath $fake -ArgumentList ('/c ping -n 60 127.0.0.1 >nul & rem --user-data-dir="'+$target+'"') -WindowStyle Hidden -PassThru}
    Start-Sleep -Milliseconds 500
    Settings '{"schema":1,"browser":"chrome","closeWeb":false}'
    Check ((Close-CloudPage "dev'ice") -eq 0 -and !$fakes[0].HasExited) 'nothing closes while the setting is off'
    Settings '{"schema":1,"browser":"chrome","closeWeb":true}'
    $closed=Close-CloudPage "dev'ice"
    Check ($closed -eq 1 -and $fakes[0].WaitForExit(5000) -and !$fakes[1].HasExited) 'stopping closes only this device''s page window'
    [pscustomobject]@{passed=$checks.Count;failed=0;skipped=0;checks=$checks}|ConvertTo-Json -Depth 4
}finally{
    foreach($process in $fakes){if(!$process.HasExited){Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue}}
    Start-Sleep -Milliseconds 300
    $full=[IO.Path]::GetFullPath($temporary);$prefix=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if($full.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($full) -match '^cmcp-browser-[a-f0-9]{32}$'){Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue}
}
