; sprout-setup.iss - the Sprout installer (Inno Setup).
;
; Builds a single Setup.exe wizard that:
;   * lets you choose the install folder,
;   * lets you choose which libraries to install (a library brings its extensions),
;   * DOWNLOADS the latest Sprout source from GitHub at install time,
;   * registers the `sprout` command, file associations, and Start-menu shortcuts
;     (so a plain GitHub clone is "read-only" until you run this installer),
;   * on re-run offers Update / Repair / Uninstall, and detects when the repo has
;     a newer version than what you installed.
;
; Build it with:  powershell -ExecutionPolicy Bypass -File tools\build-installer.ps1

#define SproutName "Sprout"
#define SproutPublisher "Fizzexual"
#define RepoOwner "fizzexual"
#define RepoName "Sprout-"
#define SourceZipUrl "https://github.com/" + RepoOwner + "/" + RepoName + "/archive/refs/heads/main.zip"
#define VersionUrl "https://raw.githubusercontent.com/" + RepoOwner + "/" + RepoName + "/main/VERSION"

; Read the version string from ..\VERSION at compile time.
#define VerFile FileOpen("..\VERSION")
#define SproutVersion Trim(FileRead(VerFile))
#expr FileClose(VerFile)
#if SproutVersion == ""
  #define SproutVersion "0.0.0"
#endif

[Setup]
AppId={{B5E9A1C3-7D42-4F8B-9E16-3A2C5D8F0E14}
AppName={#SproutName}
AppVersion={#SproutVersion}
AppPublisher={#SproutPublisher}
AppPublisherURL=https://github.com/{#RepoOwner}/{#RepoName}
DefaultDirName={code:GetDefaultDir}
DefaultGroupName=Sprout
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=dist
OutputBaseFilename=SproutSetup
SetupIconFile=..\images\sprout.ico
UninstallDisplayIcon={app}\images\sprout.ico
WizardStyle=modern
ChangesEnvironment=yes
ChangesAssociations=yes
ArchitecturesInstallIn64BitMode=x64compatible

[Components]
Name: "core"; Description: "Sprout language + Bloom (required)"; Types: full custom; Flags: fixed
Name: "discord"; Description: "discord-bot library (chat + slash commands + the Music extension)"; Types: full

[Files]
; The global `sprout` command, placed at the install root so `%~dp0src` resolves.
Source: "sprout.cmd"; DestDir: "{app}"; Flags: ignoreversion
; The unpack/prune helper is used during install only (extracted to {tmp}).
Source: "sprout-extract.ps1"; DestDir: "{tmp}"; Flags: dontcopy

[Registry]
; .sprout -> double-click runs it; .bloom -> shows the Bloom type. Per-user (HKCU);
; removed on uninstall. Icons come from the downloaded source under {app}\images.
Root: HKCU; Subkey: "Software\Classes\.sprout"; ValueType: string; ValueName: ""; ValueData: "Sprout.Program"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\Sprout.Program"; ValueType: string; ValueName: ""; ValueData: "Sprout Program"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\Sprout.Program\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\images\sprout.ico"
Root: HKCU; Subkey: "Software\Classes\Sprout.Program\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\sprout.cmd"" ""%1"""
Root: HKCU; Subkey: "Software\Classes\.bloom"; ValueType: string; ValueName: ""; ValueData: "Bloom.File"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\Bloom.File"; ValueType: string; ValueName: ""; ValueData: "Bloom"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\Bloom.File\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\images\bloom.ico"
; Remember where + what version we installed (used to detect updates next time).
Root: HKCU; Subkey: "Software\Sprout"; ValueType: string; ValueName: "InstallDir"; ValueData: "{app}"; Flags: uninsdeletekey

[Icons]
Name: "{group}\Sprout (REPL)"; Filename: "{app}\sprout.cmd"; Parameters: "repl"; WorkingDir: "{app}"; IconFilename: "{app}\images\sprout.ico"
Name: "{group}\Sprout wiki"; Filename: "{app}\wiki\README.md"
Name: "{group}\Uninstall Sprout"; Filename: "{uninstallexe}"

[UninstallDelete]
; The source was downloaded (not in [Files]), so remove the whole folder on uninstall.
Type: filesandordirs; Name: "{app}"

[Code]
const
  EnvKey = 'Environment';

var
  DownloadPage: TDownloadWizardPage;
  MaintPage: TInputOptionWizardPage;
  IsUpgrade: Boolean;
  InstalledVersion: String;
  RepoVersion: String;
  UpdateAvailable: Boolean;

{ ---- PATH helpers (per-user) ---- }
procedure EnvAddPath(Path: String);
var Paths: String;
begin
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', Paths) then Paths := '';
  if Pos(';' + Uppercase(Path) + ';', ';' + Uppercase(Paths) + ';') > 0 then exit;
  if (Paths <> '') and (Paths[Length(Paths)] <> ';') then Paths := Paths + ';';
  RegWriteExpandStringValue(HKCU, EnvKey, 'Path', Paths + Path);
end;

procedure EnvRemovePath(Path: String);
var Paths: String; P: Integer;
begin
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', Paths) then exit;
  P := Pos(';' + Uppercase(Path) + ';', ';' + Uppercase(Paths) + ';');
  if P = 0 then exit;
  Delete(Paths, P - 1, Length(Path) + 1);
  RegWriteExpandStringValue(HKCU, EnvKey, 'Path', Paths);
end;

{ ---- helpers ---- }
function NodeInstalled: Boolean;
var ResultCode: Integer;
begin
  Result := Exec('cmd.exe', '/c node --version', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

function ReadVersionFile(FileName: String): String;
var S: AnsiString;
begin
  if LoadStringFromFile(FileName, S) then Result := Trim(String(S)) else Result := '';
end;

function TryGetRepoVersion: String;
begin
  Result := '';
  try
    DownloadTemporaryFile('{#VersionUrl}', 'repo_version.txt', '', nil);
    Result := ReadVersionFile(ExpandConstant('{tmp}\repo_version.txt'));
  except
    Result := '';
  end;
end;

function FindUninstaller: String;
var FindRec: TFindRec; Dir: String;
begin
  Result := '';
  if not RegQueryStringValue(HKCU, 'Software\Sprout', 'InstallDir', Dir) then exit;
  if Dir = '' then exit;
  if FindFirst(Dir + '\unins*.exe', FindRec) then
  try
    Result := Dir + '\' + FindRec.Name;
  finally
    FindClose(FindRec);
  end;
end;

function BuildKeepList: String;
begin
  Result := '';
  if WizardIsComponentSelected('discord') then Result := Result + 'discord-bot,';
  { add future libraries here, e.g.:  if WizardIsComponentSelected('foo') then Result := Result + 'foo,'; }
  if Result = '' then Result := '__none__'
  else Delete(Result, Length(Result), 1);
end;

{ Reuse the saved install folder on a re-run; otherwise the per-user default. }
function GetDefaultDir(Param: String): String;
var Dir: String;
begin
  if RegQueryStringValue(HKCU, 'Software\Sprout', 'InstallDir', Dir) and (Dir <> '') then
    Result := Dir
  else
    Result := ExpandConstant('{autopf}\Sprout');
end;

function InitializeSetup: Boolean;
begin
  IsUpgrade := RegQueryStringValue(HKCU, 'Software\Sprout', 'Version', InstalledVersion) and (InstalledVersion <> '');
  Result := True;
end;

procedure InitializeWizard;
begin
  DownloadPage := CreateDownloadPage(SetupMessage(msgWizardPreparing), 'Downloading the latest Sprout from GitHub...', nil);

  if IsUpgrade then
  begin
    RepoVersion := TryGetRepoVersion;
    UpdateAvailable := (RepoVersion <> '') and (RepoVersion <> InstalledVersion);
    MaintPage := CreateInputOptionPage(wpWelcome,
      'Sprout is already installed', 'Choose what to do',
      'Sprout ' + InstalledVersion + ' is installed on this PC.',
      True, False);
    if UpdateAvailable then
      MaintPage.Add('Update to ' + RepoVersion + ' (you have ' + InstalledVersion + ')')
    else
      MaintPage.Add('Reinstall / get the latest source');
    MaintPage.Add('Repair (re-download and re-register Sprout)');
    MaintPage.Add('Uninstall Sprout');
    if UpdateAvailable then MaintPage.SelectedValueIndex := 0 else MaintPage.SelectedValueIndex := 1;
  end;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  { On an existing install, reuse the folder - skip the directory page. }
  Result := IsUpgrade and (PageID = wpSelectDir);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var ResultCode: Integer; Uninst: String;
begin
  Result := True;

  { Maintenance choice (Uninstall) on the re-run page. }
  if IsUpgrade and (MaintPage <> nil) and (CurPageID = MaintPage.ID) then
  begin
    if MaintPage.SelectedValueIndex = 2 then
    begin
      Uninst := FindUninstaller;
      if Uninst <> '' then
        Exec(Uninst, '', '', SW_SHOW, ewNoWait, ResultCode)
      else
        SuppressibleMsgBox('Could not find the uninstaller. Use Settings > Apps to remove Sprout.', mbError, MB_OK, IDOK);
      WizardForm.Close;
      Result := False;
      exit;
    end;
  end;

  { Download the source zip when leaving the Ready page. }
  if CurPageID = wpReady then
  begin
    DownloadPage.Clear;
    DownloadPage.Add('{#SourceZipUrl}', 'sprout-src.zip', '');
    DownloadPage.Show;
    try
      try
        DownloadPage.Download;
        Result := True;
      except
        SuppressibleMsgBox(AddPeriod(GetExceptionMessage), mbCriticalError, MB_OK, IDOK);
        Result := False;
      end;
    finally
      DownloadPage.Hide;
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var ResultCode: Integer; PS, Zip, Ver: String;
begin
  if CurStep = ssPostInstall then
  begin
    { Unpack the downloaded source into the app folder, keeping the chosen libraries. }
    ExtractTemporaryFile('sprout-extract.ps1');
    PS := ExpandConstant('{tmp}\sprout-extract.ps1');
    Zip := ExpandConstant('{tmp}\sprout-src.zip');
    if not Exec('powershell.exe',
        '-NoProfile -ExecutionPolicy Bypass -File "' + PS + '" -Zip "' + Zip + '" -Dest "' + ExpandConstant('{app}') + '" -Keep "' + BuildKeepList + '"',
        '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
      SuppressibleMsgBox('Sprout was set up, but unpacking the source reported a problem.', mbError, MB_OK, IDOK);

    { Record the installed version (read from the downloaded VERSION file). }
    Ver := ReadVersionFile(ExpandConstant('{app}\VERSION'));
    if Ver = '' then Ver := '{#SproutVersion}';
    RegWriteStringValue(HKCU, 'Software\Sprout', 'Version', Ver);

    { Put the install folder on PATH so `sprout` works in any terminal. }
    EnvAddPath(ExpandConstant('{app}'));

    if not NodeInstalled then
      SuppressibleMsgBox('Sprout needs Node.js to run (version 23.6 or newer).' + #13#10 +
        'Install it from https://nodejs.org and you are ready to go.', mbInformation, MB_OK, IDOK);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    EnvRemovePath(ExpandConstant('{app}'));
end;
