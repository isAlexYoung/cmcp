# Real install, upgrade, refusal and uninstall. Touches the signed-in account, so it only runs on CI machines.
param([Parameter(Mandatory=$true)][string]$Setup,[Parameter(Mandatory=$true)][string]$Version,[Parameter(Mandatory=$true)][string]$EvidenceDirectory)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true'){throw 'CI machines only: this installs, stops and removes real CMCP processes.'}
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'update-core.ps1')
$checks=New-Object 'Collections.Generic.List[string]'
function Check([bool]$Condition,[string]$Name){if(!$Condition){throw $Name};$checks.Add($Name)}
$null=New-Item -ItemType Directory -Path $EvidenceDirectory -Force
$script:run=0
function Install([string]$Directory,[string]$Tasks){
    $script:run++;$log=Join-Path ([IO.Path]::GetFullPath($EvidenceDirectory)) ('setup-'+$script:run+'.log')
    (Start-Process -FilePath $Setup -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/DIR="'+$Directory+'"'),('/TASKS="'+$Tasks+'"'),('/LOG="'+$log+'"')) -PassThru -Wait).ExitCode
}
function Registered {Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CMCP_is1' -ErrorAction SilentlyContinue}
function StartupValue {(Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue).CMCPManager}
function Preferences {Get-Content -LiteralPath (Join-Path $root 'user\application-preferences.json') -Raw -Encoding UTF8|ConvertFrom-Json}
# Windows Script Host returns question marks for characters outside the ANSI code page.
function ShortcutTarget([string]$File){(New-Object -ComObject Shell.Application).NameSpace((Split-Path $File -Parent)).ParseName((Split-Path $File -Leaf)).GetLink.Path}

$base=Join-Path $env:RUNNER_TEMP ('cmcp-installer-'+[guid]::NewGuid().ToString('N'))
# A space and non-ASCII characters are ordinary in Windows account and folder names.
$root=Join-Path $base (([string][char]0x4e2d)+[char]0x6587+' folder\CMCP')
$exe=Join-Path $root 'CMCP.exe'
$desktop=Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'CMCP.lnk'
$menu=Join-Path ([Environment]::GetFolderPath('Programs')) 'CMCP'
$startup='"'+$exe+'" --startup'

# First install with every choice selected.
Check ((Install $root 'desktopicon,startmenuicon,autostart') -eq 0) 'a first install succeeds in a folder with spaces and non-ASCII characters'
Check ((Test-CmcpTree $root $Version).version -ceq $Version) 'the installed folder matches the package manifest, with no extra files'
Check ([IO.Path]::GetFullPath((Assert-CmcpInstallRoot $root)) -ieq [IO.Path]::GetFullPath($root)) 'the self-update preflight accepts the installed folder'
$registered=Registered
Check ($registered.DisplayVersion -ceq $Version) 'Windows lists the installed version'
Check ($registered.DisplayName -ceq 'CMCP') 'Windows lists the name CMCP'
$uninstaller=([string]$registered.UninstallString).Trim('"')
Check ((Test-Path -LiteralPath $uninstaller) -and !$uninstaller.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) 'the uninstaller lives outside the program folder'
Check ((StartupValue) -ceq $startup) 'the startup choice registers this copy'
Check ((Preferences).autoStart -eq $true) 'the startup choice reaches the settings page value'
Check (@(Get-ChildItem -LiteralPath (Join-Path $root 'user') -Filter '*.json'|Where-Object {(Get-Content -LiteralPath $_.FullName -Raw) -match '"suppressDesktopShortcutPrompt":true'}).Count -eq 1) 'the manager will not ask about the desktop shortcut again'
Check ((ShortcutTarget $desktop) -ieq $exe) 'the desktop shortcut opens this copy'
Check ((ShortcutTarget (Join-Path $menu 'CMCP.lnk')) -ieq $exe) 'the Start menu shortcut opens this copy'

# Upgrade over it with every choice cleared.
$stale=Join-Path $root 'app\stale.txt';[IO.File]::WriteAllText($stale,'old')
$kept=Join-Path $root 'user\kept.txt';[IO.File]::WriteAllText($kept,'mine')
Check ((Install $root '') -eq 0) 'installing over an existing copy succeeds'
Check (!(Test-Path -LiteralPath $stale)) 'files from the old version do not survive'
Check ((Test-Path -LiteralPath $kept)) 'user data survives'
Check ((Test-CmcpTree $root $Version).version -ceq $Version) 'the upgraded folder still matches the manifest'
Check ($null -eq (StartupValue)) 'clearing the startup choice removes the entry'
Check ((Preferences).autoStart -eq $false) 'clearing the startup choice reaches the settings page value'
Check (!(Test-Path -LiteralPath $desktop)) 'clearing the desktop choice removes the shortcut'
Check (!(Test-Path -LiteralPath $menu)) 'clearing the Start menu choice removes the shortcut'

# Folders the uninstaller must never be allowed to delete.
$busy=Join-Path $base 'busy';$null=New-Item -ItemType Directory -Path $busy
$other=Join-Path $busy 'other.txt';[IO.File]::WriteAllText($other,'other')
Check ((Install $busy '') -ne 0) 'a folder holding other files is refused'
Check ((Test-Path -LiteralPath $other) -and !(Test-Path -LiteralPath (Join-Path $busy 'CMCP.exe'))) 'the refused folder is untouched'
Check ((Install (Join-Path $env:WINDIR 'CMCP-test') '') -ne 0) 'a system folder is refused'
Check ((Install ([IO.Path]::GetPathRoot($base)) '') -ne 0) 'a drive root is refused'
Check (([IO.Path]::GetFullPath(([string](Registered).InstallLocation)).TrimEnd('\')) -ieq [IO.Path]::GetFullPath($root)) 'refused installs leave the registered copy alone'

# A running manager is closed for the upgrade without user action.
$manager=Start-Process -FilePath $exe -PassThru
$deadline=[DateTime]::UtcNow.AddSeconds(30)
while([DateTime]::UtcNow -lt $deadline -and $manager.MainWindowHandle -eq 0 -and !$manager.HasExited){Start-Sleep -Milliseconds 500;$manager.Refresh()}
Start-Sleep -Seconds 5
Check (!$manager.HasExited) 'the installed manager starts'
Check ((Install $root 'desktopicon,startmenuicon,autostart') -eq 0) 'an upgrade succeeds while the manager is running'
Check ($manager.WaitForExit(5000)) 'the upgrade closed the running manager'
$left=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)})
Check ($left.Count -eq 0) 'the upgrade stopped the backend'
Check ((Start-Process -FilePath $exe -ArgumentList '--exit' -PassThru -Wait).ExitCode -eq 0) 'asking to exit with nothing running succeeds'

# Uninstall. The uninstaller hands over to a temporary copy of itself, so wait for its result.
$null=Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART') -PassThru -Wait
$deadline=[DateTime]::UtcNow.AddSeconds(180)
while([DateTime]::UtcNow -lt $deadline -and ((Test-Path -LiteralPath $root) -or (Registered) -or (Test-Path -LiteralPath $uninstaller))){Start-Sleep -Seconds 1}
Check (!(Test-Path -LiteralPath $root)) 'uninstall removes the program folder and user data'
Check ($null -eq (Registered)) 'Windows no longer lists CMCP'
Check ($null -eq (StartupValue)) 'uninstall removes the startup entry'
Check (!(Test-Path -LiteralPath $desktop) -and !(Test-Path -LiteralPath $menu)) 'uninstall removes the shortcuts'
Check (!(Test-Path -LiteralPath $uninstaller)) 'uninstall removes itself'
[ordered]@{passed=$checks.Count;failed=0;skipped=0;checks=$checks}|ConvertTo-Json
