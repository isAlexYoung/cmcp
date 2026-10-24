param([ValidateSet('check','prepare')][string]$Action,[Parameter(Mandatory=$true)][string]$InstallRoot,[Parameter(Mandatory=$true)][string]$StateDirectory,[int]$ManagerPid)
$ErrorActionPreference='Stop';. (Join-Path $PSScriptRoot 'update-core.ps1')
$phase='prepare'
function Send-UpdateProgress([string]$Stage,[long]$Received=0,[long]$Total=0,[string]$Unit='bytes'){
    if($Action -eq 'prepare'){[Console]::WriteLine((@{type='progress';stage=$Stage;received=$Received;total=$Total;unit=$Unit}|ConvertTo-Json -Compress));[Console]::Out.Flush()}
}
try{
    if(![Environment]::Is64BitOperatingSystem){throw 'Windows x64 is required'}
    $updates=Join-Path $StateDirectory 'updates';$null=New-Item -ItemType Directory -Path $updates -Force
    $id=[guid]::NewGuid().ToString('N');$transaction=Join-Path $updates $id;$null=New-Item -ItemType Directory -Path $transaction
    $current=(Get-Content -LiteralPath (Join-Path $InstallRoot 'app/package.json') -Raw -Encoding UTF8|ConvertFrom-Json).version
    if($Action -eq 'prepare'){$phase='installed';Send-UpdateProgress $phase;$InstallRoot=Assert-CmcpInstallRoot $InstallRoot {param($done,$count)Send-UpdateProgress 'installed' $done $count 'files'}}
    $phase='release';Send-UpdateProgress $phase
    $metadata=Join-Path $transaction 'release.json';Receive-CmcpFile 'https://api.github.com/repos/isAlexYoung/cmcp/releases/latest' $metadata 2097152
    $release=Select-CmcpRelease (Get-Content -LiteralPath $metadata -Raw -Encoding UTF8|ConvertFrom-Json) $current
    if(!$release){[Console]::WriteLine('{"status":"current"}');exit 0}
    if($Action -eq 'check'){[Console]::WriteLine('{"status":"available"}');exit 0}
    $zip=Join-Path $transaction $release.name;$checksum=$zip+'.sha256'
    $phase='download';Send-UpdateProgress $phase 0 $release.zip.size
    Receive-CmcpFile $release.zip.browser_download_url $zip 268435456 {param($done,$total)if($total -le 0){$total=$release.zip.size};Send-UpdateProgress 'download' $done $total}
    $phase='checksum';Send-UpdateProgress $phase
    Receive-CmcpFile $release.checksum.browser_download_url $checksum 1024
    if((Get-Item -LiteralPath $zip).Length -ne $release.zip.size){throw 'Update size mismatch'}
    $hash=Test-CmcpChecksum $zip (Get-Content -LiteralPath $checksum -Raw) $release.name $release.zip.digest
    $stage=Join-Path ([IO.Path]::GetDirectoryName($InstallRoot)) ('.cmcp-new-'+$id);$backup=Join-Path ([IO.Path]::GetDirectoryName($InstallRoot)) ('.cmcp-backup-'+$id)
    $phase='extract';Send-UpdateProgress $phase
    $manifest=Expand-CmcpPackage $zip $stage $release.version {param($done,$total)Send-UpdateProgress 'extract' $done $total} {param($done,$total)Send-UpdateProgress 'verify' $done $total 'files'}
    $phase='installed';Send-UpdateProgress $phase
    $null=Test-CmcpTree $InstallRoot $current {param($done,$total)Send-UpdateProgress 'installed' $done $total 'files'}
    $phase='identity';$manager=Get-Process -Id $ManagerPid
    if(!(Test-CmcpManagerPath $InstallRoot $manager.Path)){throw 'Wrong manager process'}
    $request=[ordered]@{schema=1;installRoot=$InstallRoot;staged=$stage;backup=$backup;version=$release.version;oldVersion=$current;managerPid=$ManagerPid;managerStart=$manager.StartTime.ToUniversalTime().Ticks.ToString();token=[guid]::NewGuid().ToString('N');zipHash=$hash}
    foreach($name in @('update-core.ps1','update-apply.ps1')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $transaction $name)}
    [IO.File]::WriteAllText((Join-Path $transaction 'request.json'),($request|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    [Console]::WriteLine((@{status='prepared';transaction=$id}|ConvertTo-Json -Compress))
}catch{
    $code=Get-CmcpUpdateFailureCode $_ $phase
    if($transaction -and (Test-Path -LiteralPath $transaction)){
        $failure=@{schema=1;stage=$phase;code=$code;at=[DateTime]::UtcNow.ToString('o')}
        [IO.File]::WriteAllText((Join-Path $transaction 'failure.json'),($failure|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $transaction 'failure.txt'),('Update failed: '+$code+'; stage: '+$phase+'. Installation was not replaced.'))
    }
    [Console]::WriteLine((@{status='failed';code=$code;stage=$phase}|ConvertTo-Json -Compress));exit 1
}
