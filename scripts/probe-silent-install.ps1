# Exercise the compiled installer only on a disposable Windows Actions runner.
param([Parameter(Mandatory = $true)][string]$Installer)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or -not $IsWindows) {
  throw 'Silent installer probe requires a disposable Windows CI runner.'
}
$Installer = (Resolve-Path $Installer).Path
$probeRoot = Join-Path $env:RUNNER_TEMP ('Chord silent probe ' + [guid]::NewGuid().ToString('N'))
$installDir = Join-Path $probeRoot '应用目录'
$dataDir = Join-Path $env:LOCALAPPDATA 'ChordControl'
$registryPath = 'HKCU:\Software\Chord Control\Chord Control'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$probeFailure = $null
$phase = 'initialization'
if (Test-Path $dataDir) { throw 'Probe refuses to overwrite existing controller data.' }
if (Test-Path $registryPath) { throw 'Probe refuses to overwrite existing installation metadata.' }
if (Get-Process -Name 'chord-control', 'plugin-controller' -ErrorAction SilentlyContinue) {
  throw 'Probe refuses to affect an existing host.'
}
$expectedSettings = @{
  checkIntervalMinutes = 11; autoUpdate = $false
  appCheckIntervalMinutes = 7; appAutoUpdate = $false
  catalogUrl = ''; catalogPublicKey = ''
}
$watchedNames = @([IO.Path]::GetFileNameWithoutExtension($Installer), 'chord-control', 'WebViewSetup')
# Tauri's single-instance IPC window has WS_VISIBLE but is 0x0; inspect every real window.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class ProbeWindows {
  private delegate bool Visitor(IntPtr window, IntPtr state);
  [StructLayout(LayoutKind.Sequential)]
  private struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] private static extern bool EnumWindows(Visitor visitor, IntPtr state);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  public static string[] Visible(int[] pids) {
    var owners = new HashSet<int>(pids);
    var windows = new List<string>();
    EnumWindows((window, state) => {
      uint pid; Rect rect;
      GetWindowThreadProcessId(window, out pid);
      if (owners.Contains((int)pid) && IsWindowVisible(window) && GetWindowRect(window, out rect)
          && rect.Right > rect.Left && rect.Bottom > rect.Top) {
        var title = new StringBuilder(512);
        GetWindowText(window, title, title.Capacity);
        windows.Add("pid=" + pid + " title=" + title + " size=" + (rect.Right - rect.Left) + "x" + (rect.Bottom - rect.Top));
      }
      return true;
    }, IntPtr.Zero);
    return windows.ToArray();
  }
}
'@
function Assert-Hidden {
  $pids = @(Get-Process -Name $watchedNames -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $visible = [ProbeWindows]::Visible([int[]]$pids)
  if ($visible.Count) { throw "Visible window during silent installation: $($visible -join '; ')" }
}
function Start-ProbeProcess([string]$Executable, [string]$Arguments) {
  $start = [Diagnostics.ProcessStartInfo]::new($Executable, $Arguments)
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  if (-not $process.Start()) { throw "Could not launch $Executable" }
  return $process
}
function Get-ProbeProcesses {
  Get-Process -Name 'chord-control', 'plugin-controller' -ErrorAction SilentlyContinue |
    Where-Object { -not $_.HasExited -and $_.Path -like "$installDir\*" }
}
function Write-ProbeDiagnostics {
  Get-CimInstance Win32_Process |
    Where-Object { $_.ExecutablePath -like "$installDir\*" } |
    Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine |
    Format-List | Out-String | Write-Output
  if (Test-Path $dataDir) {
    Get-ChildItem $dataDir -Recurse -File |
      Where-Object { $_.Extension -eq '.log' -or $_.Name -in @('run', 'desktop.json', 'watchdog.json') } |
      ForEach-Object { Write-Output $_.FullName; Get-Content $_.FullName -Tail 30 }
  }
}
function Stop-ProbeHost {
  $hostPath = Join-Path $installDir 'chord-control.exe'
  if (Test-Path $hostPath) {
    # A startup assertion may fail before the host has created its guard session.
    $readyDeadline = [DateTime]::UtcNow.AddSeconds(30)
    while (@(Get-ProbeProcesses).Count -gt 0 -and -not (Test-Path (Join-Path $dataDir 'guard/run'))) {
      if ([DateTime]::UtcNow -gt $readyDeadline) { throw 'Host did not initialize its maintenance session.' }
      Start-Sleep -Milliseconds 100
    }
    $stop = Start-ProbeProcess $hostPath '--maintenance-stop'
    if (-not $stop.WaitForExit(55000)) { throw 'Maintenance stop timed out.' }
    if ($stop.ExitCode -ne 0) { throw "Maintenance stop failed: $($stop.ExitCode)" }
  }
}
try {
  New-Item -ItemType Directory -Path $dataDir, $probeRoot | Out-Null
  Set-Content -Path (Join-Path $dataDir 'first-run-complete') -Value '1' -NoNewline
  @{
    format = 2; settings = $expectedSettings; plugins = @(); suppressed = @()
  } | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $dataDir 'config.json')
  foreach ($round in 1..2) {
    $phase = "round $round installation"
    Write-Output "Starting $phase"
    # /D must be the last NSIS argument, without quotes, even when the path contains spaces.
    $arguments = "/S /UPDATE /D=$installDir"
    $setup = Start-ProbeProcess $Installer $arguments
    $deadline = [DateTime]::UtcNow.AddMinutes(3)
    while (-not $setup.HasExited) {
      Assert-Hidden
      if ([DateTime]::UtcNow -gt $deadline) { throw 'Silent installer timed out.' }
      Start-Sleep -Milliseconds 100
    }
    $setup.WaitForExit()
    if ($setup.ExitCode -ne 0) { throw "Silent installer failed: $($setup.ExitCode)" }
    $phase = "round $round runtime startup"
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
      Assert-Hidden
      $runtime = @(Get-Process -Name 'plugin-controller' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq (Join-Path $installDir 'plugin-controller.exe') })
      if ($runtime.Count -eq 1) { break }
      if ([DateTime]::UtcNow -gt $deadline) { throw 'Updated host did not start its runtime.' }
      Start-Sleep -Milliseconds 100
    } while ($true)
    $phase = "round $round installed version and preferences"
    $installed = Get-Item (Join-Path $installDir 'chord-control.exe')
    $version = (Get-Content 'package.json' -Raw | ConvertFrom-Json).version
    if (-not $installed.VersionInfo.ProductVersion.StartsWith($version)) {
      throw "Unexpected installed version: $($installed.VersionInfo.ProductVersion)"
    }
    # Give controller initialization enough time to publish and persist its configuration.
    Start-Sleep -Seconds 2
    Assert-Hidden
    $saved = Get-Content (Join-Path $dataDir 'config.json') -Raw | ConvertFrom-Json
    foreach ($entry in $expectedSettings.GetEnumerator()) {
      if ($saved.settings.($entry.Key) -cne $entry.Value) { throw "Changed preference: $($entry.Key)" }
    }
    $startup = Get-ItemProperty -Path $runKey -Name 'Chord Control' -ErrorAction SilentlyContinue
    if ($null -ne $startup) { throw 'Silent update overwrote disabled login startup.' }
    Write-Output "Silent round ${round}: exit 0, version $version, no visible installer/app window, runtime running, preferences preserved."
    # Round two updates a running installation and must drain/restart its existing processes.
  }
} catch {
  $probeFailure = $_
  Write-Output "::error title=Silent installer probe::$phase failed: $($_.Exception.Message)"
  Write-Output $_.ScriptStackTrace
  Write-ProbeDiagnostics
} finally {
  try {
    Stop-ProbeHost
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (@(Get-ProbeProcesses).Count -gt 0) {
      if ([DateTime]::UtcNow -gt $deadline) {
        $remaining = @(Get-ProbeProcesses | ForEach-Object { "$($_.ProcessName) pid=$($_.Id)" })
        throw "Probe processes remained after maintenance stop: $($remaining -join ', ')"
      }
      Start-Sleep -Milliseconds 100
    }
    Remove-Item $dataDir, $probeRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $registryPath -Recurse -Force -ErrorAction SilentlyContinue
  } catch {
    Write-Output "::error title=Probe cleanup::$($_.Exception.Message)"
    Write-ProbeDiagnostics
    if ($null -eq $probeFailure) { $probeFailure = $_ }
  }
}
if ($null -ne $probeFailure) { throw $probeFailure }
