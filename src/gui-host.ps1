# gui-host.ps1 — renders a Sprout GUI as a native Windows window (WinForms,
# from the built-in .NET). It talks to the Sprout runtime (Node) over
# stdin/stdout, one JSON line per message. Launched by src/gui-native.ts —
# you don't run this directly.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)

$script:stdin = [Console]::In
$script:stdout = [Console]::Out
$script:controls = @{}
$script:fieldIds = @()

function ColorFrom($hex, $fallback) {
  if ([string]::IsNullOrWhiteSpace($hex)) { return $fallback }
  try { return [System.Drawing.ColorTranslator]::FromHtml([string]$hex) } catch { return $fallback }
}

# --- read the initial window spec (one JSON line) ---
$init = $script:stdin.ReadLine() | ConvertFrom-Json
$spec = $init.spec
$widgets = @($spec.widgets)

$bg = ColorFrom $spec.window.background ([System.Drawing.Color]::FromArgb(15, 20, 16))
$fg = ColorFrom $spec.window.text ([System.Drawing.Color]::White)

$fontFamily = 'Segoe UI'
$fontSize = 13
if ($spec.window.font) {
  $f = [string]$spec.window.font
  if ($f -match '^(.*?)\s+(\d+)$') { $fontFamily = $matches[1]; $fontSize = [int]$matches[2] }
  else { $fontFamily = $f }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = [string]$spec.title
$form.StartPosition = 'CenterScreen'
$form.BackColor = $bg
$form.ForeColor = $fg
$form.Font = New-Object System.Drawing.Font($fontFamily, [float]$fontSize)
$formHeight = [Math]::Min(720, 70 + ($widgets.Count * 50))
$form.ClientSize = New-Object System.Drawing.Size(460, $formHeight)

$panel = New-Object System.Windows.Forms.FlowLayoutPanel
$panel.Dock = 'Fill'
$panel.FlowDirection = 'TopDown'
$panel.WrapContents = $false
$panel.AutoScroll = $true
$panel.Padding = New-Object System.Windows.Forms.Padding(16)
$form.Controls.Add($panel)

function Add-Widget($w) {
  switch ([string]$w.kind) {
    'label' {
      $c = New-Object System.Windows.Forms.Label
      $c.Text = [string]$w.text
      $c.AutoSize = $true
      $c.Margin = New-Object System.Windows.Forms.Padding(3, 10, 3, 4)
      if ($w.style.text) { $c.ForeColor = ColorFrom $w.style.text $fg }
      if ($w.style.size) { $c.Font = New-Object System.Drawing.Font($fontFamily, [float]([int]$w.style.size)) }
      $script:controls[[string]$w.id] = $c
      $panel.Controls.Add($c)
    }
    'field' {
      $c = New-Object System.Windows.Forms.TextBox
      $c.Width = 380
      $c.Text = [string]$w.text
      try { $c.PlaceholderText = [string]$w.placeholder } catch { }
      if ($w.style.background) { $c.BackColor = ColorFrom $w.style.background $bg }
      if ($w.style.text) { $c.ForeColor = ColorFrom $w.style.text $fg }
      $script:controls[[string]$w.id] = $c
      $script:fieldIds += [string]$w.id
      $panel.Controls.Add($c)
    }
    'button' {
      $c = New-Object System.Windows.Forms.Button
      $c.Text = [string]$w.text
      $c.AutoSize = $true
      $c.Width = 380
      $c.FlatStyle = 'Flat'
      $c.Margin = New-Object System.Windows.Forms.Padding(3, 6, 3, 6)
      $c.BackColor = ColorFrom $w.style.background ([System.Drawing.Color]::FromArgb(123, 216, 143))
      $c.ForeColor = ColorFrom $w.style.text ([System.Drawing.Color]::Black)
      $c.Tag = [string]$w.onClick
      $c.Add_Click({
        $fields = @{}
        foreach ($fid in $script:fieldIds) { $fields[$fid] = $script:controls[$fid].Text }
        $payload = @{ type = 'click'; button = $this.Tag; fields = $fields } | ConvertTo-Json -Compress
        $script:stdout.WriteLine($payload)
        $script:stdout.Flush()
        $resp = $script:stdin.ReadLine()
        if ($resp) {
          $update = $resp | ConvertFrom-Json
          foreach ($uw in @($update.widgets)) {
            if ($script:controls.ContainsKey([string]$uw.id)) {
              $script:controls[[string]$uw.id].Text = [string]$uw.text
            }
          }
          if ($update.error) {
            [System.Windows.Forms.MessageBox]::Show([string]$update.error, 'Sprout') | Out-Null
          }
        }
      })
      $panel.Controls.Add($c)
    }
  }
}

foreach ($w in $widgets) { Add-Widget $w }

# Self-test mode: build everything but don't open the window (used by tests).
if ($init.test) {
  $script:stdout.WriteLine('SELFTEST_OK')
  $script:stdout.Flush()
  exit 0
}

$form.Add_Shown({ $form.Activate() })
[System.Windows.Forms.Application]::Run($form)
