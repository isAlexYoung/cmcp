$ErrorActionPreference='Stop'
$app=Split-Path $PSScriptRoot -Parent
. (Join-Path $app 'update-core.ps1')
$temporary=Join-Path ([IO.Path]::GetTempPath()) ('cmcp-progress-fixture-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $temporary
$checks=New-Object 'Collections.Generic.List[string]'
function Check([bool]$Value,[string]$Name){if(!$Value){throw $Name};$checks.Add($Name)}
try{
    $root=Join-Path $temporary 'CMCP-4.2.0-windows-x64';$null=New-Item -ItemType Directory -Path (Join-Path $root 'app/runtime') -Force
    $inventory=@();foreach($path in @('CMCP.exe','app/package.json','app/runtime/node.exe','app/update.ps1','app/update-core.ps1','app/update-apply.ps1','app/manager-restart.ps1')){
        $file=Join-Path $root $path;$content=if($path -eq 'app/package.json'){'{"version":"4.2.0"}'}else{'fake never executed'}
        [IO.File]::WriteAllText($file,$content);$inventory+=@{path=$path;sha256=(Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant()}
    }
    [IO.File]::WriteAllText((Join-Path $root 'app/distribution-manifest.json'),(@{schema=1;version='4.2.0';platform='windows-x64';files=$inventory}|ConvertTo-Json -Depth 5))
    $events=New-Object 'Collections.Generic.List[object]'
    $null=Test-CmcpTree $root '4.2.0' {param($done,$total)$events.Add(@{done=$done;total=$total})}
    Check ($events.Count -ge 2 -and $events[0].done -eq 0 -and $events[$events.Count-1].done -eq $inventory.Count) 'file verification reports a measured start and completion'
    Add-Type -AssemblyName System.IO.Compression.FileSystem,System.IO.Compression
    $zip=Join-Path $temporary 'package.zip';$archive=[IO.Compression.ZipFile]::Open($zip,[IO.Compression.ZipArchiveMode]::Create)
    try{foreach($file in Get-ChildItem -LiteralPath $root -File -Recurse){$name='CMCP-4.2.0-windows-x64/'+$file.FullName.Substring($root.Length+1).Replace('\','/');$null=[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$file.FullName,$name)}}finally{$archive.Dispose()}
    $extract=New-Object 'Collections.Generic.List[object]';$verify=New-Object 'Collections.Generic.List[object]'
    $null=Expand-CmcpPackage $zip (Join-Path $temporary 'stage') '4.2.0' {param($done,$total)$extract.Add(@{done=$done;total=$total})} {param($done,$total)$verify.Add(@{done=$done;total=$total})}
    Check ($extract.Count -ge 2 -and $extract[$extract.Count-1].done -eq $extract[$extract.Count-1].total) 'ZIP extraction reports measured uncompressed bytes'
    Check ($verify.Count -ge 2 -and $verify[$verify.Count-1].done -eq $inventory.Count) 'staged package verification has a separate file progress phase'
    $network=[System.Management.Automation.ErrorRecord]::new([Net.WebException]::new('DO-NOT-LOG', [Net.WebExceptionStatus]::Timeout),'test',[System.Management.Automation.ErrorCategory]::NotSpecified,$null)
    Check ((Get-CmcpUpdateFailureCode $network 'download') -eq 'timeout') 'network timeout is reported without raw server text'
    $bad=Join-Path $temporary 'incomplete';$state=Join-Path $temporary 'state';$null=New-Item -ItemType Directory -Path (Join-Path $bad 'app') -Force
    [IO.File]::WriteAllText((Join-Path $bad 'app/package.json'),'{"version":"4.1.0"}')
    $output=& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $app 'update.ps1') -Action prepare -InstallRoot $bad -StateDirectory $state -ManagerPid $PID
    $exit=$LASTEXITCODE;$packets=@($output|ForEach-Object {$_|ConvertFrom-Json})
    Check ($exit -ne 0 -and $packets[0].type -eq 'progress' -and $packets[-1].status -eq 'failed' -and $packets[-1].code -eq 'installation') 'real prepare worker emits progress and a specific failure before any replacement'
    $failure=Get-ChildItem -LiteralPath $temporary -Filter failure.json -Recurse|Select-Object -First 1
    $text=[IO.File]::ReadAllText($failure.FullName);Check ($text.Contains('installation') -and !$text.Contains('DO-NOT-LOG') -and !$text.Contains($temporary)) 'failure log contains a stage and code without private paths or raw error text'
    Check (!(Test-Path -LiteralPath (Join-Path $bad 'CMCP.exe'))) 'validation failure does not create or launch an application'
    [pscustomobject]@{passed=$checks.Count;failed=0;skipped=0;checks=$checks}|ConvertTo-Json -Depth 4
}finally{
    $resolved=[IO.Path]::GetFullPath($temporary);$parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if($resolved.StartsWith($parent,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -match '^cmcp-progress-fixture-[a-f0-9]{32}$'){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
