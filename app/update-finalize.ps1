param([Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{32}$')][string]$Transaction)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'update-core.ps1')
$install=Split-Path $PSScriptRoot -Parent
$directory=Join-Path (Join-Path (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ClaudeLocalMcp') 'updates') $Transaction
try{
    $request=Get-Content -LiteralPath (Join-Path $directory 'request.json') -Raw -Encoding UTF8|ConvertFrom-Json
    $backup=Join-Path (Split-Path $install -Parent) ('.cmcp-backup-'+$Transaction)
    if($request.installRoot -ine $install -or $request.backup -ine $backup -or (Test-CmcpTree $install).version -cne $request.version){exit 1}
    $deadline=[DateTime]::UtcNow.AddSeconds(180)
    while(!(Test-Path -LiteralPath (Join-Path $directory 'complete.txt'))){if([DateTime]::UtcNow -ge $deadline){exit 1};Start-Sleep -Milliseconds 500}
    $pending=Join-Path $install 'user\update-cleanup.json'
    [IO.File]::WriteAllText($pending,(@{installRoot=$install;backup=$backup;transaction=$directory}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    Start-Sleep -Seconds 1
    Complete-CmcpUpdate $install $backup $directory
    Remove-Item -LiteralPath $pending
}catch{exit 1}
