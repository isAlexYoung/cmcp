# Exercise real WinForms entry points with private state and harmless gated workers.
# Never restart the installed manager, touch personal state, or connect to a VPS.
param([string]$ManagerExe,[string]$EvidenceDirectory='')
$ErrorActionPreference='Stop'
if(!$ManagerExe){$ManagerExe=Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'build-results\startup\CMCP.exe'}
if(!$EvidenceDirectory){$EvidenceDirectory=Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'build-results\startup\window'}
[void][IO.Directory]::CreateDirectory($EvidenceDirectory)
$EvidenceDirectory=[IO.Path]::GetFullPath($EvidenceDirectory)
$temporary=Join-Path ([IO.Path]::GetTempPath()) ('cmcp-window-startup-'+[guid]::NewGuid().ToString('N'))
$kit=Join-Path $temporary 'app';$state=Join-Path $temporary 'state'
[void][IO.Directory]::CreateDirectory($kit);[void][IO.Directory]::CreateDirectory($state)
$checks=New-Object Collections.Generic.List[string]
$processes=New-Object Collections.Generic.List[object]
$times=@{}
function Check($ok,$name){if(!$ok){throw $name};$checks.Add($name)}
function Put([string]$path,[string]$text){[IO.File]::WriteAllText($path,$text,[Text.UTF8Encoding]::new($true))}
function Until([scriptblock]$condition,[int]$milliseconds=10000){
    $watch=[Diagnostics.Stopwatch]::StartNew()
    do{if(&$condition){return};Start-Sleep -Milliseconds 30}while($watch.ElapsedMilliseconds -lt $milliseconds)
    throw 'Timed out waiting for private startup fixture'
}
Add-Type @'
using System;using System.Runtime.InteropServices;
public static class CmcpStartupWindow {
    [DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")]public static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr hwnd,int cmd);
    [DllImport("user32.dll")]public static extern bool PostMessage(IntPtr hwnd,uint msg,IntPtr w,IntPtr l);
}
'@
$previousState=$env:CMCP_STATE_DIR
function Launch([string]$exe='CMCP.exe',[string]$arguments=''){
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=Join-Path $temporary $exe;$info.Arguments=$arguments
    $info.WorkingDirectory=$temporary;$info.UseShellExecute=$false
    $info.EnvironmentVariables['CMCP_STATE_DIR']=$state
    $p=[Diagnostics.Process]::Start($info);$processes.Add($p);return $p
}
function Visible($p){$p.Refresh();return !$p.HasExited -and $p.MainWindowHandle -ne [IntPtr]::Zero -and [CmcpStartupWindow]::IsWindowVisible($p.MainWindowHandle)}
function Close-Manager($p){$p.Refresh();[void][CmcpStartupWindow]::PostMessage($p.MainWindowHandle,0x112,[IntPtr]0xf060,[IntPtr]::Zero)}
try {
    Copy-Item -LiteralPath $ManagerExe -Destination (Join-Path $temporary 'CMCP.exe')
    $buildAlias=Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'tools\build-legacy-launcher.ps1'
    & $buildAlias -OutputFile (Join-Path $temporary 'Claude-MCP.exe') -Version ([Diagnostics.FileVersionInfo]::GetVersionInfo($ManagerExe).FileVersion -replace '\.0$','')
    if($LASTEXITCODE -ne 0){throw 'Compatibility launcher build failed'}
    Put (Join-Path $state 'application-preferences.json') '{"schema":1,"autoStart":true,"closeAction":"exit"}'
    Put (Join-Path $state 'manager-preferences.json') '{"schema":1,"suppressDesktopShortcutPrompt":true}'
    Put (Join-Path $kit 'manager-restart.ps1') @'
param([switch]$ForceRestart)
$s=$env:CMCP_STATE_DIR
[IO.File]::AppendAllText((Join-Path $s 'starts.txt'),([string][bool]$ForceRestart)+"`n")
$end=[DateTime]::UtcNow.AddSeconds(30)
while(!(Test-Path -LiteralPath (Join-Path $s 'release.flag'))){if([DateTime]::UtcNow -gt $end){exit 9};Start-Sleep -Milliseconds 30}
[IO.File]::WriteAllText((Join-Path $s 'finished.flag'),'finished')
if(Test-Path -LiteralPath (Join-Path $s 'fail.flag')){exit 1}
exit 0
'@
    Put (Join-Path $kit 'manager-exit.ps1') @'
$s=$env:CMCP_STATE_DIR
if(!(Test-Path -LiteralPath (Join-Path $s 'finished.flag'))){exit 1}
[IO.File]::WriteAllText((Join-Path $s 'exit.flag'),'exit after initialization')
exit 0
'@
    $watch=[Diagnostics.Stopwatch]::StartNew();$first=Launch
    Until {Visible $first} 5000
    $times.window_before_backend_ms=$watch.ElapsedMilliseconds
    Check (!(Test-Path (Join-Path $state 'finished.flag'))) 'real main window appears while backend initialization is still blocked'
    Until {Test-Path (Join-Path $state 'starts.txt')}
    [void][CmcpStartupWindow]::ShowWindow($first.MainWindowHandle,0)
    $automatic=Launch 'CMCP.exe' '--startup'
    Check ($automatic.WaitForExit(3000) -and $automatic.ExitCode -eq 0 -and !(Visible $first) -and (Get-Content (Join-Path $state 'starts.txt')).Count -eq 1) 'duplicate automatic startup neither raises the hidden window nor restarts its backend'
    $watch.Restart();$second=Launch 'Claude-MCP.exe'
    Check ($second.WaitForExit(3000) -and $second.ExitCode -eq 0) 'opening the other executable exits immediately while initialization is pending'
    Until {Visible $first} 3000
    $times.existing_window_restore_ms=$watch.ElapsedMilliseconds
    Check ((Get-Content (Join-Path $state 'starts.txt')).Count -eq 1) 'second executable only restores the existing window and never invokes the backend worker'
    # A real shell shortcut uses exactly the same production entry point.
    $shell=New-Object -ComObject WScript.Shell
    $link=$shell.CreateShortcut((Join-Path $temporary 'CMCP.lnk'))
    $link.TargetPath=Join-Path $temporary 'CMCP.exe';$link.WorkingDirectory=$temporary;$link.Save()
    $env:CMCP_STATE_DIR=$state
    [void][CmcpStartupWindow]::ShowWindow($first.MainWindowHandle,0)
    Start-Process -FilePath (Join-Path $temporary 'CMCP.lnk')
    Until {Visible $first} 3000
    Check ((Get-Content (Join-Path $state 'starts.txt')).Count -eq 1) 'double-click entry via a shell shortcut restores the same window without a restart'
    Close-Manager $first
    Start-Sleep -Milliseconds 300
    $times.exit_pending_process_alive=!$first.HasExited
    $times.exit_pending_finished_flag=Test-Path (Join-Path $state 'finished.flag')
    $times.exit_pending_exit_flag=Test-Path (Join-Path $state 'exit.flag')
    if($first.HasExited){$times.unexpected_exit_code=$first.ExitCode}
    Check (!$first.HasExited -and !(Test-Path (Join-Path $state 'exit.flag'))) 'exit waits for in-flight initialization before stopping the backend'
    Put (Join-Path $state 'release.flag') 'release'
    Check ($first.WaitForExit(10000) -and $first.ExitCode -eq 0 -and (Test-Path (Join-Path $state 'exit.flag'))) 'pending startup finishes before explicit exit and the manager terminates cleanly'
    # Failure must leave a responsive window, rather than delaying it or exiting silently.
    Put (Join-Path $state 'fail.flag') 'fail'
    $failed=Launch
    Until {Visible $failed} 5000
    Until {(Get-Content (Join-Path $state 'starts.txt')).Count -eq 2}
    Start-Sleep -Milliseconds 800
    Check (!$failed.HasExited -and [CmcpStartupWindow]::IsWindowEnabled($failed.MainWindowHandle)) 'backend initialization failure leaves a responsive manager window'
    Close-Manager $failed;Check ($failed.WaitForExit(10000)) 'manager can exit normally after initialization failure'
    Remove-Item -LiteralPath (Join-Path $state 'fail.flag')
    $updated=Launch 'CMCP.exe' ('--updated '+[guid]::NewGuid().ToString('N'))
    Until {Visible $updated} 5000
    Until {(Get-Content (Join-Path $state 'starts.txt')).Count -eq 3}
    Check ((Get-Content (Join-Path $state 'starts.txt')|Select-Object -Last 1) -eq 'True') 'update launch explicitly requests a fresh backend after the window is shown'
    Close-Manager $updated;Check ($updated.WaitForExit(10000)) 'updated manager exits cleanly'
    $result=@{passed=$checks.Count;failed=0;checks=@($checks);timings=$times;not_executed=@('personal backend restart','real cloud connections')}
    $result|ConvertTo-Json -Depth 5|Set-Content (Join-Path $EvidenceDirectory 'startup.json') -Encoding UTF8
    $result|ConvertTo-Json -Depth 5 -Compress
} catch {
    @{passed=$checks.Count;failed=1;checks=@($checks);error=$_.Exception.Message;timings=$times}|ConvertTo-Json -Depth 5|Set-Content (Join-Path $EvidenceDirectory 'startup.json') -Encoding UTF8
    throw
} finally {
    $env:CMCP_STATE_DIR=$previousState
    foreach($p in $processes){try{if(!$p.HasExited){$p.Kill()};$p.Dispose()}catch{}}
    # No recursive cleanup: retain this unique fixture for diagnosis. Stop only
    # workers referencing its exact path; no real CMCP process is enumerated here.
    foreach($p in @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object {([string]$_.CommandLine).Contains($kit)})){Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue}
}
