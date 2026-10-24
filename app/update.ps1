param([ValidateSet('check','prepare')][string]$Action,[Parameter(Mandatory=$true)][string]$InstallRoot,[Parameter(Mandatory=$true)][string]$StateDirectory,[int]$ManagerPid)
$ErrorActionPreference='Stop';. (Join-Path $PSScriptRoot 'update-core.ps1')
try{
    if(![Environment]::Is64BitOperatingSystem){throw 'Windows x64 is required'}
    $current=(Get-Content -LiteralPath (Join-Path $InstallRoot 'app\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    if($Action -eq 'prepare'){$InstallRoot=Assert-CmcpInstallRoot $InstallRoot}
    $updates=Join-Path $StateDirectory 'updates';$null=New-Item -ItemType Directory -Path $updates -Force
    $id=[guid]::NewGuid().ToString('N');$transaction=Join-Path $updates $id;$null=New-Item -ItemType Directory -Path $transaction
    $metadata=Join-Path $transaction 'release.json';Receive-CmcpFile 'https://api.github.com/repos/isAlexYoung/cmcp/releases/latest' $metadata 2097152
    $release=Select-CmcpRelease (Get-Content -LiteralPath $metadata -Raw -Encoding UTF8 | ConvertFrom-Json) $current
    if(!$release){[Console]::WriteLine('{"status":"current"}');exit 0}
    if($Action -eq 'check'){[Console]::WriteLine('{"status":"available"}');exit 0}
    $zip=Join-Path $transaction $release.name;$checksum=$zip+'.sha256'
    Receive-CmcpFile $release.zip.browser_download_url $zip 268435456;Receive-CmcpFile $release.checksum.browser_download_url $checksum 1024
    $hash=Test-CmcpChecksum $zip (Get-Content -LiteralPath $checksum -Raw) $release.name $release.zip.digest
    $stage=Join-Path ([IO.Path]::GetDirectoryName($InstallRoot)) ('.cmcp-new-'+$id);$backup=Join-Path ([IO.Path]::GetDirectoryName($InstallRoot)) ('.cmcp-backup-'+$id)
    $manifest=Expand-CmcpPackage $zip $stage $release.version
    # Recheck current package after download and preserve the exact process identity.
    $null=Test-CmcpTree $InstallRoot $current;$manager=Get-Process -Id $ManagerPid
    if($manager.Path -ine (Get-CmcpManagerPath $InstallRoot)){throw 'Wrong manager process'}
    $request=[ordered]@{schema=1;installRoot=$InstallRoot;staged=$stage;backup=$backup;version=$release.version;oldVersion=$current;managerPid=$ManagerPid;managerStart=$manager.StartTime.ToUniversalTime().Ticks.ToString();token=[guid]::NewGuid().ToString('N');zipHash=$hash}
    foreach($name in @('update-core.ps1','update-apply.ps1')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $transaction $name)}
    [IO.File]::WriteAllText((Join-Path $transaction 'request.json'),($request|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    [Console]::WriteLine((@{status='prepared';transaction=$id}|ConvertTo-Json -Compress))
}catch{
    # No URLs, credentials or raw HTTP bodies in updater output/logs.
    if($transaction -and (Test-Path -LiteralPath $transaction)){[IO.File]::WriteAllText((Join-Path $transaction 'failure.txt'),'Update validation or download failed. Installation was not replaced.')}
    [Console]::WriteLine('{"status":"failed"}');exit 1
}
