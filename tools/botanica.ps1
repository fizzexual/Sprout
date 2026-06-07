# Botanica - Sprout's code editor for .sprout and .bloom files.
#
# A small native editor (WinForms). Open it from a file's right-click
# "Open with -> Botanica", or run:  powershell -File tools\botanica.ps1 [file]
# "Run" saves the file and launches it with Sprout (which opens the window or
# the website) - so you never touch a terminal.

param([string]$File)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:currentFile = $File
$launcher = Join-Path $PSScriptRoot 'sprout-run.cmd'

$ink   = [System.Drawing.Color]::FromArgb(230, 239, 230)
$bg    = [System.Drawing.Color]::FromArgb(15, 20, 16)
$bar   = [System.Drawing.Color]::FromArgb(22, 29, 23)
$green = [System.Drawing.Color]::FromArgb(123, 216, 143)

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Botanica'
$form.Width = 860
$form.Height = 640
$form.StartPosition = 'CenterScreen'
$form.BackColor = $bg

$toolbar = New-Object System.Windows.Forms.FlowLayoutPanel
$toolbar.Dock = 'Top'
$toolbar.Height = 46
$toolbar.Padding = New-Object System.Windows.Forms.Padding(8, 8, 8, 8)
$toolbar.BackColor = $bar
$form.Controls.Add($toolbar)

function New-BarButton($text) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.AutoSize = $true
  $b.FlatStyle = 'Flat'
  $b.BackColor = $green
  $b.ForeColor = [System.Drawing.Color]::FromArgb(8, 18, 10)
  $b.Margin = New-Object System.Windows.Forms.Padding(4, 0, 4, 0)
  return $b
}
$btnOpen = New-BarButton 'Open'
$btnSave = New-BarButton 'Save'
$btnRun  = New-BarButton 'Run'
$toolbar.Controls.AddRange(@($btnOpen, $btnSave, $btnRun))

$editor = New-Object System.Windows.Forms.TextBox
$editor.Multiline = $true
$editor.Dock = 'Fill'
$editor.AcceptsTab = $true
$editor.ScrollBars = 'Both'
$editor.WordWrap = $false
$editor.BackColor = [System.Drawing.Color]::FromArgb(13, 17, 13)
$editor.ForeColor = $ink
$editor.Font = New-Object System.Drawing.Font('Consolas', 12)
$form.Controls.Add($editor)
$editor.BringToFront()

function Set-Title() {
  if ($script:currentFile) { $form.Text = "Botanica - $([System.IO.Path]::GetFileName($script:currentFile))" }
  else { $form.Text = 'Botanica' }
}
function Load-File($path) {
  if ($path -and (Test-Path $path)) {
    $editor.Text = [System.IO.File]::ReadAllText($path)
    $script:currentFile = $path
    Set-Title
  }
}
function Save-File() {
  if (-not $script:currentFile) {
    $dlg = New-Object System.Windows.Forms.SaveFileDialog
    $dlg.Filter = 'Sprout (*.sprout)|*.sprout|Bloom (*.bloom)|*.bloom|All files (*.*)|*.*'
    if ($dlg.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return $false }
    $script:currentFile = $dlg.FileName
  }
  [System.IO.File]::WriteAllText($script:currentFile, $editor.Text)
  Set-Title
  return $true
}

$btnOpen.Add_Click({
  $dlg = New-Object System.Windows.Forms.OpenFileDialog
  $dlg.Filter = 'Sprout & Bloom|*.sprout;*.bloom|All files (*.*)|*.*'
  if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Load-File $dlg.FileName }
})
$btnSave.Add_Click({ [void](Save-File) })
$btnRun.Add_Click({
  if (-not (Save-File)) { return }
  if ($script:currentFile.ToLower().EndsWith('.sprout')) {
    Start-Process -FilePath $launcher -ArgumentList ('"' + $script:currentFile + '"')
  } else {
    [System.Windows.Forms.MessageBox]::Show('Run works on .sprout files. (A .bloom is a stylesheet.)', 'Botanica') | Out-Null
  }
})

Load-File $script:currentFile
Set-Title

# Self-test mode (used by tests): build the editor but don't show it.
if ($env:BOTANICA_SELFTEST -eq '1') {
  [System.Console]::Out.WriteLine('BOTANICA_OK')
  exit 0
}

[System.Windows.Forms.Application]::Run($form)
