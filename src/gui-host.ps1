# gui-host.ps1 - renders a Sprout GUI as a native Windows window (WinForms,
# from the built-in .NET). It talks to the Sprout runtime (Node) over
# stdin/stdout, one JSON line per message. Launched by src/gui-native.ts.
#
# Styling is applied only where Bloom provides it; with no style the window
# keeps the plain system look (raw, like HTML with no CSS).

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

$form = New-Object System.Windows.Forms.Form
$form.Text = [string]$spec.title
$form.StartPosition = 'CenterScreen'
if ($spec.topMost) { $form.TopMost = $true }
$formHeight = [Math]::Min(720, 90 + ($widgets.Count * 50))
$form.ClientSize = New-Object System.Drawing.Size(460, $formHeight)

# Window-level Bloom styling (only if provided).
if ($spec.window.background) { $form.BackColor = ColorFrom $spec.window.background $form.BackColor }
if ($spec.window.text) { $form.ForeColor = ColorFrom $spec.window.text $form.ForeColor }
$fontFamily = $form.Font.FontFamily.Name
if ($spec.window.font) {
  $f = [string]$spec.window.font
  if ($f -match '^(.*?)\s+(\d+)$') {
    $fontFamily = $matches[1]
    $form.Font = New-Object System.Drawing.Font($fontFamily, [float][int]$matches[2])
  } else {
    $fontFamily = $f
    $form.Font = New-Object System.Drawing.Font($fontFamily, $form.Font.Size)
  }
}

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
      if ($w.style.text) { $c.ForeColor = ColorFrom $w.style.text $c.ForeColor }
      if ($w.style.size) { $c.Font = New-Object System.Drawing.Font($fontFamily, [float]([int]$w.style.size)) }
      $script:controls[[string]$w.id] = $c
      $panel.Controls.Add($c)
    }
    'field' {
      $c = New-Object System.Windows.Forms.TextBox
      $c.Width = 380
      $c.Text = [string]$w.text
      try { $c.PlaceholderText = [string]$w.placeholder } catch { }
      if ($w.style.background) { $c.BackColor = ColorFrom $w.style.background $c.BackColor }
      if ($w.style.text) { $c.ForeColor = ColorFrom $w.style.text $c.ForeColor }
      $script:controls[[string]$w.id] = $c
      $script:fieldIds += [string]$w.id
      $panel.Controls.Add($c)
    }
    'button' {
      $c = New-Object System.Windows.Forms.Button
      $c.Text = [string]$w.text
      $c.AutoSize = $true
      $c.Width = 380
      $c.Margin = New-Object System.Windows.Forms.Padding(3, 6, 3, 6)
      if ($w.style.background) { $c.FlatStyle = 'Flat'; $c.BackColor = ColorFrom $w.style.background $c.BackColor }
      if ($w.style.text) { $c.ForeColor = ColorFrom $w.style.text $c.ForeColor }
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

$form.Add_Shown({ $form.Activate(); $form.ActiveControl = $null })  # don't auto-focus a button (a stray Enter could fire it)
[System.Windows.Forms.Application]::Run($form)
