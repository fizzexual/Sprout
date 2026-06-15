; sprout-setup.iss — a friendly GUI installer wizard for Sprout (Inno Setup 6).
; Smart: if Sprout is already installed, it greets you with Repair / Update / Remove.
; Otherwise it does a normal Welcome -> Install -> Finish. Installs per-user (no admin),
; adds Sprout to PATH, makes shortcuts, and registers an uninstaller in Add/Remove Programs.
;
;   build-setup.cmd        (runs ISCC -> dist\SproutSetup.exe)
; Build the interpreter first:  cd ..\src && build.cmd

#define AppVer "0.1.2"

[Setup]
AppId={{B7E3F1A2-9C4D-4E8B-A1F6-3D5C7E9A0B12}
AppName=Sprout
AppVersion={#AppVer}
AppPublisher=Fizzexual
AppPublisherURL=https://github.com/fizzexual/Sprout
DefaultDirName={localappdata}\Programs\Sprout
UsePreviousAppDir=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=dist
OutputBaseFilename=SproutSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ChangesEnvironment=yes
SetupIconFile=..\images\sprout.ico
UninstallDisplayName=Sprout
UninstallDisplayIcon={app}\sprout.exe

[Files]
Source: "..\src\sprout.exe"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
Root: HKCU; Subkey: "Software\Sprout"; ValueType: string; ValueName: "Version"; ValueData: "{#AppVer}"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Sprout"; ValueType: string; ValueName: "InstallDir"; ValueData: "{app}"

[Icons]
Name: "{autoprograms}\Sprout"; Filename: "{app}\sprout.exe"
Name: "{autodesktop}\Sprout"; Filename: "{app}\sprout.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; Flags: unchecked

[Run]
Filename: "{app}\sprout.exe"; Description: "Open Sprout now"; Flags: postinstall nowait skipifsilent

[Code]
const EnvKey = 'Environment';
var MaintPage: TInputOptionWizardPage;

function GetUninstaller(): string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER,
       'Software\Microsoft\Windows\CurrentVersion\Uninstall\{B7E3F1A2-9C4D-4E8B-A1F6-3D5C7E9A0B12}_is1',
       'UninstallString', Result) then
    Result := '';
end;

function IsInstalled(): Boolean;
begin
  Result := GetUninstaller() <> '';
end;

function InstalledVersion(): string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Software\Sprout', 'Version', Result) then
    Result := '';
end;

procedure AddToPath();
var Paths: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', Paths) then Paths := '';
  if Pos(';' + Uppercase(ExpandConstant('{app}')) + ';', ';' + Uppercase(Paths) + ';') > 0 then
    exit;
  if Paths = '' then
    Paths := ExpandConstant('{app}')
  else
    Paths := ExpandConstant('{app}') + ';' + Paths;   { prepend so it survives a long PATH }
  RegWriteExpandStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', Paths);
end;

procedure RemoveFromPath();
var Paths, AppDir: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', Paths) then
    exit;
  AppDir := ExpandConstant('{app}');
  Paths := ';' + Paths + ';';
  StringChangeEx(Paths, ';' + AppDir + ';', ';', True);
  if (Length(Paths) > 0) and (Paths[1] = ';') then Delete(Paths, 1, 1);
  if (Length(Paths) > 0) and (Paths[Length(Paths)] = ';') then Delete(Paths, Length(Paths), 1);
  RegWriteExpandStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', Paths);
end;

procedure InitializeWizard();
begin
  if IsInstalled() then
  begin
    MaintPage := CreateInputOptionPage(wpWelcome,
      'Sprout is already installed',
      'Sprout version ' + InstalledVersion() + ' is already on this computer.',
      'What would you like to do?', True, False);
    MaintPage.Add('Repair  -  reinstall Sprout (fix the files and PATH)');
    MaintPage.Add('Update  -  reinstall with this installer (version {#AppVer})');
    MaintPage.Add('Remove  -  uninstall Sprout from this computer');
    MaintPage.SelectedValueIndex := 0;
  end;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if IsInstalled() and (PageID = wpSelectDir) then   { keep the existing folder }
    Result := True;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var unins: string; rc: Integer;
begin
  Result := True;
  if Assigned(MaintPage) and (CurPageID = MaintPage.ID) and (MaintPage.SelectedValueIndex = 2) then
  begin
    { Remove chosen: launch the uninstaller and close this setup }
    unins := GetUninstaller();
    if unins <> '' then
    begin
      unins := RemoveQuotes(unins);
      Exec(unins, '', '', SW_SHOWNORMAL, ewNoWait, rc);
    end;
    Result := False;
    WizardForm.Close;
  end;
  { Repair / Update (index 0 or 1) fall through and reinstall, overwriting files. }
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then AddToPath();
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then RemoveFromPath();
end;
