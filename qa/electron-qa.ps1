# Runs the packaged SiberSentez.exe (dist\win-unpacked) with a TEMPORARY hub and data folder and the --qa switch.
# Never runs the installer, never touches the real %USERPROFILE%\SiberSentez or %APPDATA%\SiberSentez, never uses 4545.
# HIDDEN by default (SIBERSENTEZ_QA_HIDDEN=1): no window is ever shown, no tray icon, no native dialog, no notification;
# the person at this computer keeps working while it runs. A visible top-level window of the app under test ends the
# run at once (every process of dist\win-unpacked\SiberSentez.exe is stopped) and is reported.
# Usage (repo root): pwsh -NoProfile -File qa\electron-qa.ps1            (hidden)
#                    pwsh -NoProfile -File qa\electron-qa.ps1 -Visible   (windows shown without focus, as before)
param([switch]$Visible)
$ErrorActionPreference = 'Stop'
$Hidden = -not $Visible
$Root = Split-Path -Parent $PSScriptRoot
$AppDir = Join-Path $Root 'dist\win-unpacked'
$Exe = Join-Path $AppDir 'SiberSentez.exe'
$Shot = Join-Path $Root 'qa\electron-pencere.png'
$PanelShot = Join-Path $Root 'qa\electron-panel.png'
$TempRoot = [IO.Path]::GetTempPath()
$T = Join-Path $TempRoot ('sibersentez-qa-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$Hub = Join-Path $T 'hub'
$Data = Join-Path $T 'data'
$ProjectDir = Join-Path $T 'qa-project'
$MainLog = Join-Path $Data 'logs\main.log'
$Skeleton = @('settings.json', 'registry\projects.json', 'library\catalog.json', 'library\README.md')
$R = [ordered]@{ mode = $(if ($Hidden) { 'hidden' } else { 'visible' }) }
$Checks = [ordered]@{}

function Say($m) { Write-Host "[qa] $m" }
function Check([string]$name, $ok) { $Checks[$name] = [bool]$ok }

# Visible top-level windows of the given processes (EnumWindows + IsWindowVisible)
Add-Type -Namespace SiberSentezQa -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, System.IntPtr lParam);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
public delegate bool EnumWindowsProc(System.IntPtr hWnd, System.IntPtr lParam);
public static System.Collections.Generic.List<uint> VisibleOwners(uint[] pids) {
  var set = new System.Collections.Generic.HashSet<uint>(pids);
  var hits = new System.Collections.Generic.List<uint>();
  EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (set.Contains(p) && IsWindowVisible(h)) hits.Add(p); return true; }, System.IntPtr.Zero);
  return hits;
}
'@

function App-Processes { @(Get-CimInstance Win32_Process -Filter "Name='SiberSentez.exe'" | Where-Object { $_.ExecutablePath -eq $Exe }) }
function Stop-All { App-Processes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }
$script:VisibleSeen = @()

# Throws (after stopping every process of the app) as soon as a hidden run shows a window
function Assert-NothingVisible([string]$when) {
  if (-not $Hidden) { return }
  $pids = [uint32[]]@(App-Processes | ForEach-Object { [uint32]$_.ProcessId })
  if (-not $pids.Count) { return }
  $hits = [SiberSentezQa.Win]::VisibleOwners($pids)
  if ($hits.Count) {
    $script:VisibleSeen += "$when (pid $($hits -join ','))"
    Stop-All
    throw "a visible window appeared during a hidden run ($when); every SiberSentez.exe of dist\win-unpacked was stopped"
  }
}

function Wait-Exit([Diagnostics.Process]$p, [int]$timeoutMs, [string]$when) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while (-not $p.HasExited) {
    Assert-NothingVisible $when
    if ($sw.ElapsedMilliseconds -gt $timeoutMs) { return $false }
    Start-Sleep -Milliseconds 150
  }
  Assert-NothingVisible $when
  return $true
}

function Start-App([hashtable]$envs, [string[]]$argv = @('--qa'), [string]$hub = $Hub) {
  $psi = [Diagnostics.ProcessStartInfo]::new($Exe)
  $psi.UseShellExecute = $false
  $psi.WorkingDirectory = $Root
  foreach ($a in $argv) { $psi.ArgumentList.Add($a) }
  foreach ($k in @('SIBERSENTEZ_HUB', 'SIBERSENTEZ_DATA_DIR', 'SIBERSENTEZ_QA_SHOT', 'SIBERSENTEZ_QA_QUIT_MS', 'SIBERSENTEZ_QA_DELAY_MS', 'SIBERSENTEZ_QA_ACTIONS', 'SIBERSENTEZ_QA_HIDDEN', 'SIBERSENTEZ_QA_PROBES', 'SIBERSENTEZ_QA_PROJECT_DIR', 'SIBERSENTEZ_ACTIONS', 'SIBERSENTEZ_PORT', 'SIBERSENTEZ_INSTANCE', 'SIBERSENTEZ_KIT')) { [void]$psi.Environment.Remove($k) }
  $psi.Environment['SIBERSENTEZ_HUB'] = $hub
  $psi.Environment['SIBERSENTEZ_DATA_DIR'] = $Data
  if ($Hidden) { $psi.Environment['SIBERSENTEZ_QA_HIDDEN'] = '1' }
  foreach ($k in $envs.Keys) { $psi.Environment[$k] = [string]$envs[$k] }
  return [Diagnostics.Process]::Start($psi)
}

function Log-Lines { if (Test-Path $MainLog) { @(Get-Content $MainLog -Encoding utf8) } else { @() } }

function Wait-Log([int]$from, [string]$pattern, [int]$timeoutSec) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
    Assert-NothingVisible "waiting for /$pattern/"
    $hit = Log-Lines | Select-Object -Skip $from | Where-Object { $_ -match $pattern } | Select-Object -First 1
    if ($hit) { return $hit }
    Start-Sleep -Milliseconds 250
  }
  return $null
}

function Strip($line) { if ($line) { $line -replace '^\S+ ', '' } else { $null } }
function First-Log($lines, $pattern) { Strip ($lines | Where-Object { $_ -match $pattern } | Select-Object -First 1) }
function Hash($p) { (Get-FileHash -Algorithm SHA256 $p).Hash }
# The value of "QA probe <name>: <value>" (JSON when it parses, else the text)
function Probe($lines, [string]$name) {
  $line = $lines | Where-Object { $_ -match ([regex]::Escape("QA probe ${name}: ")) } | Select-Object -Last 1
  if (-not $line) { return $null }
  $text = $line.Substring($line.IndexOf("QA probe ${name}: ") + "QA probe ${name}: ".Length)
  try { return $text | ConvertFrom-Json -ErrorAction Stop } catch { return $text }
}
# What the real user folders look like (write time and size of each file, recursively). Only informative: an installed
# SiberSentez that is running writes its own hub and data folder by itself.
function Fingerprint([string]$dir) {
  if (-not (Test-Path $dir)) { return 'missing' }
  $files = @(Get-ChildItem -LiteralPath $dir -Recurse -File -Force -ErrorAction SilentlyContinue | Sort-Object FullName | ForEach-Object { "$($_.FullName)|$($_.Length)|$($_.LastWriteTimeUtc.Ticks)" })
  $bytes = [Text.Encoding]::UTF8.GetBytes($files -join "`n")
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))
}
# Traces of a QA run in a real folder: the temp root's name in any file of it, or a QA line in its logs
function QA-Traces([string]$dir) {
  if (-not (Test-Path $dir)) { return @() }
  @(Get-ChildItem -LiteralPath $dir -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.Length -lt 20MB } | Where-Object {
      $text = Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue
      $text -and ($text.Contains('sibersentez-qa-') -or $text.Contains('QA shell: ') -or $text.Contains('QA probe '))
    } | ForEach-Object { $_.FullName })
}

$RealHub = Join-Path $env:USERPROFILE 'SiberSentez'
$RealData = Join-Path $env:APPDATA 'SiberSentez'

try {
  # ------------------------------------------------------------ pre-checks
  if (-not (Test-Path $Exe)) { throw "packaged app missing: $Exe" }
  if ((App-Processes).Count) { throw 'dist\win-unpacked\SiberSentez.exe is already running' }
  $R.pre_4545_listening = @(Get-NetTCPConnection -LocalPort 4545 -State Listen -ErrorAction SilentlyContinue).Count -gt 0
  $R.pre_appdata_sibersentez = Test-Path $RealData
  $R.pre_userprofile_sibersentez = Test-Path $RealHub
  $fpHub = Fingerprint $RealHub
  $fpData = Fingerprint $RealData
  $tracesBefore = @(QA-Traces $RealHub) + @(QA-Traces $RealData)
  New-Item -ItemType Directory -Force $T | Out-Null
  New-Item -ItemType Directory -Force $ProjectDir | Out-Null
  Say "mode: $($R.mode); temp root: $T"
  foreach ($f in @($Shot, $PanelShot)) { if (Test-Path $f) { Remove-Item -LiteralPath $f } }

  # ------------------------------------------------------------ the kit next to the app archive
  $R.resources_kit_catalog = Test-Path (Join-Path $AppDir 'resources\kit\catalog.json')
  $R.resources_kit_license = Test-Path (Join-Path $AppDir 'resources\kit\LICENSE.md')
  Check 'packaged: resources\kit is next to app.asar' ($R.resources_kit_catalog -and $R.resources_kit_license)

  # ------------------------------------------------------------ run 1: skeleton, port, window, permissions, clean exit
  $from = (Log-Lines).Count
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-App @{ SIBERSENTEZ_QA_SHOT = $Shot; SIBERSENTEZ_QA_DELAY_MS = '6000' }
  if (-not (Wait-Exit $p 120000 'run 1')) { $p.Kill(); throw 'run 1 timed out' }
  $R.run1_exit_code = $p.ExitCode
  $R.run1_seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  Start-Sleep -Seconds 2
  $lines = Log-Lines | Select-Object -Skip $from
  $ready = $lines | Where-Object { $_ -match 'server ready: http://127\.0\.0\.1:(\d+)/' } | Select-Object -Last 1
  $R.port = if ($ready -match ':(\d+)/') { [int]$Matches[1] } else { $null }
  $R.port_in_own_range = ($null -ne $R.port) -and ($R.port -ge 47700) -and ($R.port -le 47799)
  $R.server_kind = if ($lines -match 'server started \(utilityProcess') { 'utilityProcess' } else { '?' }
  $R.run1_hub_log = First-Log $lines ' hub: '
  $R.run1_language_log = First-Log $lines 'language: '
  $R.run1_permissions = First-Log $lines 'QA permissions: '
  $R.run1_qa_shell = First-Log $lines 'QA shell: '
  $R.run1_hidden_logs = @($lines | Where-Object { $_ -match 'QA hidden: ' } | ForEach-Object { Strip $_ })
  $R.hub_files = @(Get-ChildItem -Recurse -File $Hub | ForEach-Object { $_.FullName.Substring($Hub.Length + 1) })
  $R.hub_skeleton_complete = @($Skeleton | Where-Object { -not (Test-Path (Join-Path $Hub $_)) }).Count -eq 0
  $R.window_loaded = [bool]($lines -match 'window loaded')
  $R.screenshot_saved = (Test-Path $Shot) -and ((Get-Item $Shot).Length -gt 10000)
  $R.clean_exit_logged = [bool](($lines -match 'stopping server') -and ($lines -match 'app closed'))
  $R.run1_leftover_processes = (App-Processes).Count
  $R.run1_port_still_listening = @(Get-NetTCPConnection -LocalPort $R.port -State Listen -ErrorAction SilentlyContinue).Count -gt 0
  Check 'run 1: exit code 0' ($R.run1_exit_code -eq 0)
  Check 'run 1: server on its own port range (utilityProcess)' ($R.port_in_own_range -and $R.server_kind -eq 'utilityProcess')
  Check 'run 1: hub skeleton created in the temp hub' $R.hub_skeleton_complete
  Check 'run 1: page loaded in the window' $R.window_loaded
  Check 'run 1: screenshot of the page saved' $R.screenshot_saved
  Check 'run 1: clean exit, nothing left running, port free' ($R.clean_exit_logged -and $R.run1_leftover_processes -eq 0 -and -not $R.run1_port_still_listening)
  if ($Hidden) {
    Check 'hidden: the window stayed hidden, no tray icon' ((($lines -match 'QA hidden: the window is ready and stays hidden').Count -gt 0) -and (($lines -match 'QA hidden: no tray icon').Count -gt 0))
    Check 'hidden: notifications denied in the page' ($R.run1_permissions -match 'notifications=denied')
  }
  Say "run 1: exit $($R.run1_exit_code), port $($R.port), leftover $($R.run1_leftover_processes)"

  # ------------------------------------------------------------ run 2: hand-edited files survive, settings language wins,
  # an existing screenshot file is never overwritten ('wx')
  $settings = Join-Path $Hub 'settings.json'
  $readme = Join-Path $Hub 'library\README.md'
  [IO.File]::WriteAllText($settings, "{`n  `"version`": 1,`n  `"language`": `"en`",`n  `"note`": `"edited by the user`"`n}`n")
  Add-Content -Path $readme -Value 'A line added by the user.' -Encoding utf8
  Remove-Item -LiteralPath (Join-Path $Hub 'registry\projects.json')   # a deleted skeleton file must come back
  $h1 = Hash $settings; $h2 = Hash $readme; $hShot = Hash $Shot
  $from = (Log-Lines).Count
  $p = Start-App @{ SIBERSENTEZ_QA_SHOT = $Shot; SIBERSENTEZ_QA_DELAY_MS = '3000' }
  if (-not (Wait-Exit $p 120000 'run 2')) { $p.Kill(); throw 'run 2 timed out' }
  $R.run2_exit_code = $p.ExitCode
  Start-Sleep -Seconds 2
  $lines = Log-Lines | Select-Object -Skip $from
  $R.run2_language_log = First-Log $lines 'language: '
  $R.edited_settings_kept = (Hash $settings) -eq $h1
  $R.edited_readme_kept = (Hash $readme) -eq $h2
  $R.deleted_projects_json_recreated = Test-Path (Join-Path $Hub 'registry\projects.json')
  $R.run2_screenshot_log = First-Log $lines 'QA: screenshot'
  $R.existing_screenshot_not_overwritten = (Hash $Shot) -eq $hShot
  $R.run2_leftover_processes = (App-Processes).Count
  Check 'run 2: hand-edited files kept, deleted skeleton file back' ($R.edited_settings_kept -and $R.edited_readme_kept -and $R.deleted_projects_json_recreated)
  Check 'run 2: an existing screenshot is never overwritten' $R.existing_screenshot_not_overwritten
  Say "run 2: exit $($R.run2_exit_code), settings kept $($R.edited_settings_kept)"

  # ------------------------------------------------------------ run 3: single-instance lock + restart after a server crash
  $from = (Log-Lines).Count
  $a = Start-App @{ SIBERSENTEZ_QA_QUIT_MS = '45000' }
  if (-not (Wait-Log $from 'server ready' 60)) { $a.Kill(); throw 'instance A never became ready' }
  $swB = [Diagnostics.Stopwatch]::StartNew()
  # the second launch carries --qa too: it only meets the lock and exits, and never runs as a visible instance
  $b = Start-App @{ SIBERSENTEZ_QA_QUIT_MS = '5000' }
  $bExited = Wait-Exit $b 15000 'run 3, second launch'
  $R.second_instance_exited = $bExited
  $R.second_instance_seconds = [math]::Round($swB.Elapsed.TotalSeconds, 2)
  if (-not $bExited) { $b.Kill() }
  $R.first_instance_notified = Strip (Wait-Log $from 'second launch: ' 10)
  $R.second_instance_logged = [bool](Wait-Log $from 'another SiberSentez is already running' 5)
  $srv = App-Processes | Where-Object { $_.ParentProcessId -eq $a.Id -and $_.CommandLine -match 'utility-sub-type=node' } | Select-Object -First 1
  $R.server_process_found = [bool]$srv
  if ($srv) {
    $fromKill = (Log-Lines).Count
    Stop-Process -Id $srv.ProcessId -Force
    $R.crash_logged = Strip (Wait-Log $fromKill 'server exited' 10)
    $R.restart_logged = Strip (Wait-Log $fromKill 'server restart in' 10)
    $R.ready_again = Strip (Wait-Log $fromKill 'server ready' 40)
  }
  if (-not (Wait-Exit $a 60000 'run 3')) { $a.Kill(); throw 'instance A did not exit' }
  $R.first_instance_exit_code = $a.ExitCode
  Start-Sleep -Seconds 3
  $R.run3_leftover_processes = (App-Processes).Count
  Check 'run 3: a second launch exits at once and the first one is told' ($R.second_instance_exited -and $R.second_instance_logged -and $R.first_instance_notified)
  if ($Hidden) { Check 'hidden: a second launch does not show the window' ($R.first_instance_notified -match 'stays hidden') }
  Check 'run 3: a crashed server is restarted and ready again' ($R.crash_logged -and $R.restart_logged -and $R.ready_again)
  Check 'run 3: nothing left running' ($R.run3_leftover_processes -eq 0)
  Say "single instance: B exited=$bExited ($($R.second_instance_seconds) s)"

  # ------------------------------------------------------------ run 4: a hub inside the program folder is never prepared
  $inside = Join-Path $AppDir 'hub-inside-app'
  $from = (Log-Lines).Count
  $p = Start-App @{ SIBERSENTEZ_QA_QUIT_MS = '8000' } @('--qa') $inside
  if (-not (Wait-Exit $p 60000 'run 4')) { $p.Kill(); throw 'run 4 timed out' }
  Start-Sleep -Seconds 2
  $lines = Log-Lines | Select-Object -Skip $from
  $R.run4_overlap_log = First-Log $lines 'overlaps the program folder'
  $R.run4_hub_folder_created = Test-Path $inside

  # ------------------------------------------------------------ run 4b: the same through a junction (temp -> program folder)
  $junction = Join-Path $T 'junction-to-app'
  New-Item -ItemType Junction -Path $junction -Target $AppDir | Out-Null
  $viaJunction = Join-Path $junction 'hub-via-junction'
  $from = (Log-Lines).Count
  $p = Start-App @{ SIBERSENTEZ_QA_QUIT_MS = '8000' } @('--qa') $viaJunction
  if (-not (Wait-Exit $p 60000 'run 4b')) { $p.Kill(); throw 'run 4b timed out' }
  Start-Sleep -Seconds 2
  $lines = Log-Lines | Select-Object -Skip $from
  $R.run4b_overlap_log = First-Log $lines 'overlaps the program folder'
  $R.run4b_hub_folder_created = Test-Path (Join-Path $AppDir 'hub-via-junction')
  [IO.Directory]::Delete($junction)   # removes only the link, never the target
  $R.run4b_junction_removed_app_intact = (-not (Test-Path $junction)) -and (Test-Path $Exe)
  Check 'run 4: a hub inside the program folder (also through a junction) is never prepared' ($R.run4_overlap_log -and -not $R.run4_hub_folder_created -and $R.run4b_overlap_log -and -not $R.run4b_hub_folder_created -and $R.run4b_junction_removed_app_intact)

  # ------------------------------------------------------------ run 5: without --qa a packaged build ignores SIBERSENTEZ_QA_*
  # A run without --qa is a normal start: it would put an icon in the tray. Only in a visible run.
  if ($Hidden) {
    $R.run5 = 'skipped: a start without --qa puts an icon in the tray (covered by the readQaOptions unit tests)'
  } else {
    $from = (Log-Lines).Count
    $p = Start-App @{ SIBERSENTEZ_QA_QUIT_MS = '2000'; SIBERSENTEZ_QA_SHOT = (Join-Path $T 'must-not-exist.png') } @('--hidden')
    $ignored = Wait-Log $from 'SIBERSENTEZ_QA_\* ignored' 20
    Start-Sleep -Seconds 8
    $R.run5_ignored_log = Strip $ignored
    $R.run5_still_running_after_quit_ms = -not $p.HasExited
    $R.run5_no_screenshot = -not (Test-Path (Join-Path $T 'must-not-exist.png'))
    Stop-All
    Start-Sleep -Seconds 3
    Check 'run 5: without --qa the QA variables are ignored' ($R.run5_ignored_log -and $R.run5_still_running_after_quit_ms -and $R.run5_no_screenshot)
  }

  # ------------------------------------------------------------ run 6: the QA probes (bridge, kit, actions, project, panel)
  $from = (Log-Lines).Count
  $envs = @{ SIBERSENTEZ_QA_PROBES = '1'; SIBERSENTEZ_QA_SHOT = $PanelShot; SIBERSENTEZ_QA_QUIT_MS = '240000'; SIBERSENTEZ_QA_DELAY_MS = '4000' }
  if ($Hidden) { $envs.SIBERSENTEZ_QA_PROJECT_DIR = $ProjectDir }
  $p = Start-App $envs
  if (-not (Wait-Exit $p 260000 'run 6')) { $p.Kill(); throw 'run 6 timed out' }
  $R.run6_exit_code = $p.ExitCode
  Start-Sleep -Seconds 2
  $lines = Log-Lines | Select-Object -Skip $from
  $P6 = [ordered]@{}
  foreach ($n in @('hidden', 'bridge', 'kit', 'about', 'kit folder', 'actions live via bridge', 'actions live via tray', 'actions dry', 'actions off', 'folder rule inside the hub', 'folder rule holding the hub', 'folder rule system folder', 'project-add', 'project-idea', 'actions panel', 'terminal', 'hidden at the end')) { $P6[$n] = Probe $lines $n }
  $R.run6_probes = $P6
  $R.run6_panel_shot_log = First-Log $lines 'QA: screenshot'
  $R.run6_live_saved_logged = [bool]($lines -match '-> live: saved')
  $settingsNow = Get-Content (Join-Path $Hub 'settings.json') -Raw -Encoding utf8 | ConvertFrom-Json
  $R.run6_settings_actions_after = $settingsNow.actions
  $discoveredFile = Join-Path $Hub 'registry\discovered.json'
  $disc = if (Test-Path $discoveredFile) { Get-Content $discoveredFile -Raw -Encoding utf8 | ConvertFrom-Json } else { $null }
  $entry = if ($disc) { $disc.projects | Where-Object { $_.path -eq $ProjectDir } | Select-Object -First 1 } else { $null }
  $R.run6_discovered_entry = $entry
  Check 'run 6: exit code 0' ($R.run6_exit_code -eq 0)
  Check 'probe: window.sibersentezShell has exactly its six functions' ($P6['bridge'] -eq 'pickLibraryFolder:function,pickProjectFolder:function,saveProjectIdea:function,setActionsMode:function,setAttention:function,setLanguage:function')
  # The expected counts come from the kit's own catalog, so a bigger kit needs no edit here
  $kitCat = Get-Content (Join-Path $PSScriptRoot '..\kit\catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $kitSkills = @($kitCat.items | Where-Object { $_.kind -eq 'skill' }).Count
  $kitAgents = @($kitCat.items | Where-Object { $_.kind -eq 'agent' }).Count
  Check "probe: the roster shows the kit, $kitSkills skills + $kitAgents agents (catalog)" ($P6['kit'].skill -eq $kitSkills -and $P6['kit'].agent -eq $kitAgents)
  Check 'probe: /api/about gives the packaged version and Electron' ($P6['about'].version -eq (Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).version -and $P6['about'].electron)
  Check 'probe: the packaged app reads resources\kit' ($P6['kit folder'].packaged -and $P6['kit folder'].resourcesKit)
  Check "probe: live refused through the bridge (panel path)" ($P6['actions live via bridge'].reply.changed -eq $false -and $P6['actions live via bridge'].stored -eq 'off')
  Check "probe: live refused through the tray's path" ($P6['actions live via tray'].changed -eq $false -and $P6['actions live via tray'].reason -eq 'cancelled' -and $P6['actions live via tray'].stored -eq 'off')
  Check "probe: setActionsMode('dry') through the bridge saves dry; the same server serves it at once" ($P6['actions dry'].reply.changed -and $P6['actions dry'].stored -eq 'dry' -and $P6['actions dry'].served.status -eq 200 -and $P6['actions dry'].served.mode -eq 'dry' -and $P6['actions dry'].sameServer)
  Check "probe: back to 'off' the same way (the actions routes answer 404 again)" ($P6['actions off'].reply.changed -and $P6['actions off'].stored -eq 'off' -and $P6['actions off'].served.status -eq 404 -and $P6['actions off'].sameServer)
  Check 'QA never reached live (settings.json off at the end, no live save logged)' ($R.run6_settings_actions_after -eq 'off' -and -not $R.run6_live_saved_logged)
  Check 'probe: node-pty loads from outside the archive and runs a command (embedded terminal)' ($P6['terminal'].unpacked -and $P6['terminal'].loaded -and $P6['terminal'].exitCode -eq 0 -and $P6['terminal'].echoed)
  Check 'probe: the actions panel opens (?qa=1&actpanel=choose)' ($P6['actions panel'] -eq 'open')
  Check 'probe: screenshot of the panel saved' ((Test-Path $PanelShot) -and ((Get-Item $PanelShot).Length -gt 10000))
  if ($Hidden) {
    Check 'probe: folder rules (inside the hub / holding the hub -> hub, system folder -> broad)' ($P6['folder rule inside the hub'] -eq 'hub' -and $P6['folder rule holding the hub'] -eq 'hub' -and $P6['folder rule system folder'] -eq 'broad')
    Check 'probe: project-add over the server channel (no picker)' ($P6['project-add'].ok -and $P6['project-add'].reason -eq 'added' -and $P6['project-add'].projectId)
    Check 'probe: the idea is kept' ($P6['project-idea'].ok)
    Check "discovered.json: the folder with via 'sibersentez' and its idea" ($entry -and (@($entry.via) -contains 'sibersentez') -and $entry.idea)
    Check 'hidden: window never visible, no tray (probes, start and end)' ($P6['hidden'].hidden -and -not $P6['hidden'].visible -and -not $P6['hidden'].tray -and -not $P6['hidden at the end'].visible -and -not $P6['hidden at the end'].tray)
  }
  Say "run 6: exit $($R.run6_exit_code), probes $(@($P6.Values | Where-Object { $_ -ne $null }).Count)/$($P6.Count)"
} catch {
  $R.error = "$_"
  Say "ERROR: $_"
  Stop-All
} finally {
  # ------------------------------------------------------------ final state
  Start-Sleep -Seconds 1
  $R.final_leftover_processes = (App-Processes).Count
  if ($R.final_leftover_processes) { Stop-All }
  $R.visible_windows_seen = $script:VisibleSeen
  $R.final_appdata_sibersentez = Test-Path $RealData
  $R.final_userprofile_sibersentez = Test-Path $RealHub
  # informative (a running installed SiberSentez writes these itself); the check is the QA traces below
  $R.real_hub_files_changed_during_run = (Fingerprint $RealHub) -ne $fpHub
  $R.real_data_files_changed_during_run = (Fingerprint $RealData) -ne $fpData
  $tracesAfter = @(QA-Traces $RealHub) + @(QA-Traces $RealData)
  $R.qa_traces_in_real_folders = @($tracesAfter | Where-Object { $tracesBefore -notcontains $_ })
  $R.real_hub_untouched = $R.qa_traces_in_real_folders.Count -eq 0
  $R.real_data_untouched = $R.real_hub_untouched
  $R.final_4545_listening = @(Get-NetTCPConnection -LocalPort 4545 -State Listen -ErrorAction SilentlyContinue).Count -gt 0
  $R.log_mentions_4545 = [bool]((Log-Lines) -match ':4545')
  Check 'no error in the script' (-not $R.error)
  if ($Hidden) { Check 'hidden: no visible window of the app at any time' ($script:VisibleSeen.Count -eq 0) }
  Check 'nothing left running' ($R.final_leftover_processes -eq 0)
  Check 'the real hub and %APPDATA%\SiberSentez untouched; 4545 unchanged' ($R.real_hub_untouched -and $R.real_data_untouched -and ($R.final_4545_listening -eq $R.pre_4545_listening) -and -not $R.log_mentions_4545)

  # Copy the evidence logs under qa\ (home folder already hidden), then delete only this script's temp root
  if (Test-Path $MainLog) { Copy-Item $MainLog (Join-Path $Root 'qa\electron-qa-main.log') -Force }
  if (Test-Path (Join-Path $Data 'logs\server.log')) { Copy-Item (Join-Path $Data 'logs\server.log') (Join-Path $Root 'qa\electron-qa-server.log') -Force }
  $R.temp_root = $T
  if ($T.StartsWith($TempRoot) -and (Split-Path -Leaf $T) -like 'sibersentez-qa-*' -and (Test-Path $T)) { Remove-Item -LiteralPath $T -Recurse -Force }
  $R.temp_root_deleted = -not (Test-Path $T)
  Check 'the temp root is deleted' $R.temp_root_deleted

  $passed = @($Checks.Values | Where-Object { $_ }).Count
  $R.checks = $Checks
  $R.checks_passed = "$passed/$($Checks.Count)"
  $R | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $Root 'qa\electron-qa-sonuc.json')
  foreach ($k in $Checks.Keys) { Write-Host ("[{0}] {1}" -f $(if ($Checks[$k]) { 'PASS' } else { 'FAIL' }), $k) }
  Say "checks: $($R.checks_passed)"
}
