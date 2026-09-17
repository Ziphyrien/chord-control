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
function Assert-Hidden {
  foreach ($process in @(Get-Process -Name $watchedNames -ErrorAction SilentlyContinue)) {
    $process.Refresh()
    if ($process.MainWindowHandle -ne 0) {
      throw "Visible window during silent installation: $($process.ProcessName) / $($process.MainWindowTitle)"
    }
  }
}
function Stop-ProbeHost {
  $hostPath = Join-Path $installDir 'chord-control.exe'
  if (Test-Path $hostPath) {
    $stop = Start-Process -FilePath $hostPath -ArgumentList '--maintenance-stop' -PassThru
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
    # /D must be the last NSIS argument, without quotes, even when the path contains spaces.
    $arguments = "/S /UPDATE /D=$installDir"
    $setup = Start-Process -FilePath $Installer -ArgumentList $arguments -PassThru
    $deadline = [DateTime]::UtcNow.AddMinutes(3)
    while (-not $setup.HasExited) {
      Assert-Hidden
      if ([DateTime]::UtcNow -gt $deadline) { throw 'Silent installer timed out.' }
      Start-Sleep -Milliseconds 100
    }
    $setup.WaitForExit()
    if ($setup.ExitCode -ne 0) { throw "Silent installer failed: $($setup.ExitCode)" }
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
      Assert-Hidden
      $runtime = @(Get-Process -Name 'plugin-controller' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq (Join-Path $installDir 'plugin-controller.exe') })
      if ($runtime.Count -eq 1) { break }
      if ([DateTime]::UtcNow -gt $deadline) { throw 'Updated host did not start its runtime.' }
      Start-Sleep -Milliseconds 100
    } while ($true)
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
} finally {
  Stop-ProbeHost
  foreach ($process in @(Get-Process -Name 'chord-control', 'plugin-controller' -ErrorAction SilentlyContinue)) {
    if ($process.Path -like "$installDir\*") { throw 'Probe process remained after maintenance stop.' }
  }
  Remove-Item $dataDir, $probeRoot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $registryPath -Recurse -Force -ErrorAction SilentlyContinue
}
