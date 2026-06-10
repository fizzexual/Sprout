; sprout-setup.iss — a friendly GUI installer wizard for Sprout (Inno Setup 6).
; Bundles the C interpreter (sprout.exe), installs per-user (no admin), adds it to
; PATH, makes shortcuts, and registers an uninstaller (Add/Remove Programs).
;
;   "C:\Users\<you>\AppData\Local\Programs\Inno Setup 6\ISCC.exe" sprout-setup.iss
;   -> dist\SproutSetup.exe
;
; Build the interpreter first:  cd ..\src && build.cmd

#define AppVer "0.0.2"

[Setup]
AppId={{B7E3F1A2-9C4D-4E8B-A1F6-3D5C7E9A0B12}
AppName=Sprout
AppVersion={#AppVer}
AppPublisher=Fizzexual
AppPublisherURL=https://github.com/fizzexual/Sprout
DefaultDirName={localappdata}\Programs\Sprout
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

[Icons]
Name: "{autoprograms}\Sprout"; Filename: "{app}\sprout.exe"
Name: "{autodesktop}\Sprout"; Filename: "{app}\sprout.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; Flags: unchecked

[Run]
Filename: "{app}\sprout.exe"; Description: "Open Sprout now"; Flags: postinstall nowait skipifsilent

[Code]
const EnvKey = 'Environment';

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

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then AddToPath();
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then RemoveFromPath();
end;
