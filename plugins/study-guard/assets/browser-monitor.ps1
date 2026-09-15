$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Publish-BrowserEvent($value) { [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
$browserSession = (Get-Process -Id $PID).SessionId
function Get-BrowserRoots { @(Get-CimInstance Win32_Process -Filter "(Name='msedge.exe' OR Name='chrome.exe') AND SessionId=$browserSession" | Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type(?:=|\s)' }) }
$browserSeen = [Collections.Generic.HashSet[int]]::new()
foreach ($entry in (Get-BrowserRoots)) { $browserSeen.Add([int]$entry.ProcessId) | Out-Null }
$browserAllow = @{}
$browserPaths = @{}
$browserRead = [Console]::In.ReadLineAsync()
Publish-BrowserEvent @{type='ready'}
while ($true) {
  if ($browserRead.IsCompleted) {
    $browserLine = $browserRead.GetAwaiter().GetResult()
    if ($null -eq $browserLine) { break }
    try {
      $browserCommand = $browserLine | ConvertFrom-Json
      if ($browserCommand.type -eq 'launch' -and $browserCommand.browser -in @('edge','chrome')) {
        $kind = $browserCommand.browser
        $executable = $browserPaths[$kind]
        if (-not $executable) {
          $suffix = if ($kind -eq 'edge') { 'Microsoft\Edge\Application\msedge.exe' } else { 'Google\Chrome\Application\chrome.exe' }
          foreach ($folder in @(${env:ProgramFiles(x86)},$env:ProgramFiles,$env:LOCALAPPDATA)) { if ($folder) { $candidate = Join-Path $folder $suffix; if (Test-Path -LiteralPath $candidate) { $executable=$candidate; break } } }
        }
        if (-not $executable) { throw 'Browser is not installed' }
        $browserAllow[$kind] = [DateTime]::UtcNow.AddSeconds(3)
        $browserStarted = Start-Process -FilePath $executable -ArgumentList '--new-window' -PassThru
        $browserSeen.Add($browserStarted.Id) | Out-Null
      }
    } catch { Publish-BrowserEvent @{type='error';message=$_.Exception.Message} }
    $browserRead = [Console]::In.ReadLineAsync()
  }
  try {
    $browserCurrent = [Collections.Generic.HashSet[int]]::new()
    foreach ($entry in (Get-BrowserRoots)) {
      $processNumber = [int]$entry.ProcessId
      $browserCurrent.Add($processNumber) | Out-Null
      if ($browserSeen.Contains($processNumber)) { continue }
      $kind = if ($entry.Name -eq 'msedge.exe') { 'edge' } else { 'chrome' }
      if ($browserAllow.ContainsKey($kind) -and $browserAllow[$kind] -gt [DateTime]::UtcNow) { continue }
      if ($entry.ExecutablePath) { $browserPaths[$kind]=$entry.ExecutablePath }
      Stop-Process -Id $processNumber -Force -ErrorAction Stop
      Publish-BrowserEvent @{type='blocked';browser=$kind}
    }
    $browserSeen = $browserCurrent
  } catch { Publish-BrowserEvent @{type='error';message=$_.Exception.Message} }
  Start-Sleep -Milliseconds 350
}
