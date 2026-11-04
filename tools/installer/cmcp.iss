; Guided per-user Windows installer. Built by tools/package-installer.ps1 from a verified portable folder.
#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef SourceDir
  #error SourceDir is required
#endif

[Setup]
AppId=CMCP
AppName=CMCP
AppVersion={#AppVersion}
AppVerName=CMCP {#AppVersion}
AppPublisher=CMCP
AppPublisherURL=https://github.com/isAlexYoung/cmcp
VersionInfoVersion={#AppVersion}
; Per-user: self-update replaces this folder and writes beside it, so it must stay writable without elevation.
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\CMCP
DisableDirPage=auto
DisableProgramGroupPage=yes
; The update check rejects unknown files in the program folder, so the uninstaller lives elsewhere.
UninstallFilesDir={localappdata}\CMCP\uninstall
UninstallDisplayName=CMCP
UninstallDisplayIcon={app}\CMCP.exe
SetupIconFile={#SourceDir}\app\assets\cmcp.ico
OutputBaseFilename=CMCP-{#AppVersion}-windows-x64-setup
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
SetupMutex=CMCP-Setup
; PrepareToInstall closes CMCP through its own exit path, which also stops the backend.
CloseApplications=no
RestartApplications=no

[Languages]
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
chinesesimplified.ConfirmUninstall=确定要卸载 %1 吗？%n%n将断开全部连接，移除云电脑上的 Claude 配置，并删除本机保存的地址、密码和设置。
english.ConfirmUninstall=Uninstall %1?%n%nThis disconnects everything, removes the Claude configuration from cloud PCs, and deletes saved addresses, passwords and settings.

[CustomMessages]
chinesesimplified.GroupShortcuts=快捷方式：
english.GroupShortcuts=Shortcuts:
chinesesimplified.TaskDesktop=创建桌面快捷方式
english.TaskDesktop=Create a desktop shortcut
chinesesimplified.TaskStartMenu=添加到开始菜单
english.TaskStartMenu=Add to the Start menu
chinesesimplified.GroupStartup=开机启动：
english.GroupStartup=Startup:
chinesesimplified.TaskAutoStart=开机时自动启动 CMCP
english.TaskAutoStart=Start CMCP when I sign in to Windows
chinesesimplified.LaunchNow=立即启动 CMCP
english.LaunchNow=Start CMCP now
chinesesimplified.UninstallLink=卸载 CMCP
english.UninstallLink=Uninstall CMCP
chinesesimplified.DirSystem=不能安装到这个位置，请选择或新建一个单独的文件夹。
english.DirSystem=CMCP cannot be installed here. Choose or create a separate folder.
chinesesimplified.DirNotEmpty=这个文件夹里已有其他文件。请选择一个空文件夹，或原有的 CMCP 文件夹。
english.DirNotEmpty=This folder already contains other files. Choose an empty folder or an existing CMCP folder.
chinesesimplified.DirNotWritable=当前账户无法写入这个位置，请换一个文件夹。
english.DirNotWritable=Your account cannot write to this location. Choose another folder.
chinesesimplified.CloseFailed=无法自动关闭正在运行的 CMCP。请从系统托盘退出 CMCP 后重试。
english.CloseFailed=CMCP could not be closed automatically. Exit CMCP from the system tray and try again.
chinesesimplified.ChoicesFailed=CMCP 已安装，但开机启动设置未能保存。可以稍后在 CMCP 的设置页修改。
english.ChoicesFailed=CMCP is installed, but the startup choice could not be saved. You can change it later in CMCP settings.
chinesesimplified.UninstallCleaning=正在断开连接，并移除云电脑上的配置...
english.UninstallCleaning=Disconnecting and removing the configuration from cloud PCs...
chinesesimplified.UninstallPartial=部分内容未能清理，例如某台云电脑上的配置或本机设置。程序文件仍会继续删除。
english.UninstallPartial=Some items could not be cleaned up, such as configuration on a cloud PC or local settings. Program files will still be removed.

[Tasks]
Name: "desktopicon"; Description: "{cm:TaskDesktop}"; GroupDescription: "{cm:GroupShortcuts}"
Name: "startmenuicon"; Description: "{cm:TaskStartMenu}"; GroupDescription: "{cm:GroupShortcuts}"
Name: "autostart"; Description: "{cm:TaskAutoStart}"; GroupDescription: "{cm:GroupStartup}"; Flags: unchecked

[InstallDelete]
; Self-update rejects any file the package manifest does not list, so nothing old may survive an upgrade.
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\tools"
Type: files; Name: "{userdesktop}\CMCP.lnk"; Tasks: not desktopicon; Check: PreviouslyInstalled
Type: filesandordirs; Name: "{userprograms}\CMCP"; Tasks: not startmenuicon; Check: PreviouslyInstalled

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; This comment marks the shortcut as CMCP's own, as the manager's shortcut code expects.
Name: "{userdesktop}\CMCP"; Filename: "{app}\CMCP.exe"; WorkingDir: "{app}"; Comment: "CMCP desktop shortcut"; Tasks: desktopicon
Name: "{userprograms}\CMCP\CMCP"; Filename: "{app}\CMCP.exe"; WorkingDir: "{app}"; Tasks: startmenuicon
Name: "{userprograms}\CMCP\{cm:UninstallLink}"; Filename: "{uninstallexe}"; Tasks: startmenuicon

[Run]
Filename: "{app}\CMCP.exe"; Description: "{cm:LaunchNow}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Self-update adds files the install log does not know about. PrepareToInstall vetted this folder.
Type: filesandordirs; Name: "{app}"

[Code]
const
  UninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\CMCP_is1';
  RunKey = 'Software\Microsoft\Windows\CurrentVersion\Run';
  RunValue = 'CMCPManager';

function PreviouslyInstalled(): Boolean;
begin
  Result := RegValueExists(HKCU, UninstallKey, 'InstallLocation');
end;

function SameDir(A, B: String): Boolean;
begin
  Result := CompareText(RemoveBackslashUnlessRoot(A), RemoveBackslashUnlessRoot(B)) = 0;
end;

function IsInside(Child, Parent: String): Boolean;
var
  Prefix: String;
begin
  Prefix := AddBackslash(Parent);
  Result := CompareText(Copy(AddBackslash(Child), 1, Length(Prefix)), Prefix) = 0;
end;

function HasEntries(Dir: String): Boolean;
var
  Found: TFindRec;
begin
  Result := False;
  if FindFirst(AddBackslash(Dir) + '*', Found) then
  try
    repeat
      if (Found.Name <> '.') and (Found.Name <> '..') then
      begin
        Result := True;
        Exit;
      end;
    until not FindNext(Found);
  finally
    FindClose(Found);
  end;
end;

// Updates write next to the program folder, so the nearest existing parent must accept a file.
function ParentWritable(Dir: String): Boolean;
var
  Existing, Parent, Probe: String;
begin
  Result := False;
  Existing := ExtractFileDir(Dir);
  while not DirExists(Existing) do
  begin
    Parent := ExtractFileDir(Existing);
    if (Parent = '') or (Parent = Existing) then Exit;
    Existing := Parent;
  end;
  Probe := AddBackslash(Existing) + '.cmcp-probe-' + GetDateTimeString('hhnnsszzz', #0, #0);
  Result := SaveStringToFile(Probe, '', False);
  if Result then DeleteFile(Probe);
end;

function DirProblem(Dir: String): String;
var
  Value: String;
begin
  Result := '';
  Value := RemoveBackslashUnlessRoot(Dir);
  // The uninstaller removes this whole folder, so it must only ever hold CMCP.
  if (Copy(Value, 1, 2) = '\\') or (ExtractFileDir(Value) = Value)
    or SameDir(Value, ExpandConstant('{%USERPROFILE}'))
    or SameDir(Value, ExpandConstant('{userdesktop}'))
    or SameDir(Value, ExpandConstant('{userdocs}'))
    or SameDir(Value, ExpandConstant('{localappdata}'))
    or SameDir(Value, ExpandConstant('{localappdata}\Programs'))
    or SameDir(Value, ExpandConstant('{userappdata}'))
    or IsInside(Value, ExpandConstant('{win}'))
    or IsInside(Value, ExpandConstant('{commonpf64}'))
    or IsInside(Value, ExpandConstant('{commonpf32}')) then
    Result := CustomMessage('DirSystem')
  else if DirExists(Value) and HasEntries(Value)
    and not FileExists(AddBackslash(Value) + 'app\distribution-manifest.json') then
    Result := CustomMessage('DirNotEmpty')
  else if not ParentWritable(Value) then
    Result := CustomMessage('DirNotWritable');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Problem: String;
begin
  Result := True;
  if CurPageID = wpSelectDir then
  begin
    Problem := DirProblem(WizardDirValue());
    if Problem <> '' then
    begin
      MsgBox(Problem, mbError, MB_OK);
      Result := False;
    end;
  end;
end;

// Also runs for silent installs, which skip the folder page.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
  Existing: String;
begin
  Result := DirProblem(ExpandConstant('{app}'));
  if Result <> '' then Exit;
  // The new CMCP.exe closes the account's running manager, wherever that copy was installed.
  ExtractTemporaryFile('CMCP.exe');
  if not Exec(ExpandConstant('{tmp}\CMCP.exe'), '--exit', ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
  begin
    Result := CustomMessage('CloseFailed');
    Exit;
  end;
  // The copy in this folder also stops a backend whose manager is already gone.
  Existing := ExpandConstant('{app}\CMCP.exe');
  if FileExists(Existing) and FileExists(ExpandConstant('{app}\app\manager-exit.ps1')) then
    Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + ExpandConstant('{app}\app\manager-exit.ps1') + '"',
      ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, Code);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
  AutoStart, Language: String;
begin
  if CurStep <> ssPostInstall then Exit;
  if WizardIsTaskSelected('autostart') then AutoStart := 'on' else AutoStart := 'off';
  if ActiveLanguage() = 'english' then Language := 'en' else Language := 'zh-CN';
  if not Exec(ExpandConstant('{app}\CMCP.exe'), '--apply-installer-choices ' + AutoStart + ' ' + Language, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
    SuppressibleMsgBox(CustomMessage('ChoicesFailed'), mbInformation, MB_OK, IDOK);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: Integer;
  App, Arguments, Value: String;
begin
  if CurUninstallStep <> usUninstall then Exit;
  App := ExpandConstant('{app}');
  Exec(App + '\CMCP.exe', '--exit', ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, Code);
  UninstallProgressForm.StatusLabel.Caption := CustomMessage('UninstallCleaning');
  Arguments := '-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "' + App + '\app\uninstall.ps1"';
  if (not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Arguments, ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0))
    and not UninstallSilent() then
    MsgBox(CustomMessage('UninstallPartial'), mbInformation, MB_OK);
  // Only remove the startup entry when it points at this copy.
  if RegQueryStringValue(HKCU, RunKey, RunValue, Value) and (CompareText(Value, '"' + App + '\CMCP.exe" --startup') = 0) then
    RegDeleteValue(HKCU, RunKey, RunValue);
end;
