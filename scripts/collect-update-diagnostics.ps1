[CmdletBinding()]
param(
    [string]$Destination,
    [datetime]$Since = (Get-Date).AddHours(-24),
    [string]$InstallDirectory
)

# Read-only collection: never start/stop the app, run an installer, or alter settings.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$updateData = Join-Path $env:LOCALAPPDATA 'ChordControl'
$updateRoot = Join-Path $updateData 'updates'
$collectionErrors = [Collections.Generic.List[object]]::new()
if (-not $Destination) {
    $Destination = [Environment]::GetFolderPath('DesktopDirectory')
    if (-not $Destination) { $Destination = Join-Path $updateData 'diagnostics' }
}
$Destination = [IO.Path]::GetFullPath($Destination)
$collectionName = 'Chord-update-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6)
$collectionPath = Join-Path $Destination $collectionName
New-Item -ItemType Directory -Path $collectionPath -Force | Out-Null

function Save-Report([string]$Name, $Value) {
    ConvertTo-Json -InputObject $Value -Depth 10 | Set-Content -LiteralPath (Join-Path $collectionPath $Name) -Encoding UTF8
}
function Read-Field($Value, [string]$Name) {
    if ($null -eq $Value) { return $null }
    $property = $Value.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}
function Protect-EventMessage([string]$Text) {
    # Event providers may include command lines even though processes.json omits them.
    return [regex]::Replace($Text, '(?i)(--(?:watchdog|guard-resume)["'']?\s+)(?:"[^"]*"|''[^'']*''|[^\s<>"'']+)', '$1[redacted]')
}
function Note-Error([string]$Source, $Failure) {
    $collectionErrors.Add([pscustomobject]@{source=$Source; message=[string]$Failure})
}

$installedPaths = [Collections.Generic.List[string]]::new()
if ($InstallDirectory) { $installedPaths.Add($InstallDirectory) }
$installedPaths.Add($PSScriptRoot)
$installedPaths.Add((Join-Path $env:LOCALAPPDATA 'Chord Control'))
try {
    $startupEntry = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction Stop
    $startupCommand = Read-Field $startupEntry 'Chord Control'
    if ($startupCommand -and $startupCommand -match '^"([^"]+\\chord-control\.exe)"(?:\s|$)') {
        $installedPaths.Add((Split-Path -Parent $Matches[1]))
    }
} catch { Note-Error 'startup-registration' $_.Exception.Message }

$processes = @()
try {
    $processes = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -in @('chord-control.exe', 'plugin-controller.exe') -or
        ($_.Name -eq 'install.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith(($updateRoot + '\'), [StringComparison]::OrdinalIgnoreCase))
    } | ForEach-Object {
        $role = 'controller'
        if ($_.Name -eq 'install.exe') { $role = 'installer' }
        elseif ($_.Name -eq 'chord-control.exe') {
            if ($_.CommandLine -match '--watchdog') { $role = 'watchdog' }
            elseif ($_.CommandLine -match '--maintenance-stop') { $role = 'maintenance' }
            else { $role = 'desktop' }
            if ($_.ExecutablePath) { $installedPaths.Add((Split-Path -Parent $_.ExecutablePath)) }
        }
        # Do not export command lines: guard arguments contain session tokens.
        [pscustomobject]@{pid=$_.ProcessId; parentPid=$_.ParentProcessId; role=$role; executable=$_.ExecutablePath; created=$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null })}
    })
} catch { Note-Error 'processes' $_.Exception.Message }
Save-Report 'processes.json' @($processes)

$installations = @($installedPaths | Select-Object -Unique | ForEach-Object {
    $binaryPath = Join-Path $_ 'chord-control.exe'
    if (Test-Path -LiteralPath $binaryPath -PathType Leaf) {
        try {
            $binary = Get-Item -LiteralPath $binaryPath
            [pscustomobject]@{path=$binary.FullName; version=$binary.VersionInfo.ProductVersion; size=$binary.Length; modified=$binary.LastWriteTimeUtc.ToString('o'); sha256=(Get-FileHash -LiteralPath $binaryPath -Algorithm SHA256).Hash}
        } catch { Note-Error 'installed-binary' $_.Exception.Message }
    }
})
Save-Report 'installed.json' @($installations)

$installers = @()
try {
    if (Test-Path -LiteralPath $updateRoot -PathType Container) {
        $installers = @(Get-ChildItem -LiteralPath $updateRoot -Directory | ForEach-Object {
            try {
                $candidate = Join-Path $_.FullName 'install.exe'
                if (Test-Path -LiteralPath $candidate -PathType Leaf) { Get-Item -LiteralPath $candidate }
            } catch { Note-Error 'staged-installer-metadata' $_.Exception.Message }
        } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 10 | ForEach-Object {
            try {
                [pscustomobject]@{path=$_.FullName; version=$_.VersionInfo.ProductVersion; size=$_.Length; created=$_.CreationTimeUtc.ToString('o'); modified=$_.LastWriteTimeUtc.ToString('o'); sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}
            } catch { Note-Error 'staged-installer' $_.Exception.Message }
        })
    }
} catch { Note-Error 'staged-installers' $_.Exception.Message }
Save-Report 'installers.json' @($installers)

# Copy only diagnostic logs. Config files, plugin data, and guard identity files stay private.
$copiedLogs = @()
foreach ($logName in @('host.log', 'host.previous.log', 'installer.log', 'installer.previous.log')) {
    $logPath = Join-Path $updateRoot $logName
    try {
        if (Test-Path -LiteralPath $logPath -PathType Leaf) {
            $target = Join-Path $collectionPath $logName
            if ((Get-Item -LiteralPath $logPath).Length -le 2MB) {
                Copy-Item -LiteralPath $logPath -Destination $target
            } else {
                Get-Content -LiteralPath $logPath -Tail 2000 -Encoding UTF8 | Set-Content -LiteralPath $target -Encoding UTF8
            }
            $copiedLogs += $logName
        }
    } catch { Note-Error $logName $_.Exception.Message }
}

$settings = $null
try {
    $configuration = Get-Content -LiteralPath (Join-Path $updateData 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $savedSettings = Read-Field $configuration 'settings'
    $settings = [pscustomobject]@{
        appAutoUpdate=(Read-Field $savedSettings 'appAutoUpdate')
        appCheckIntervalMinutes=(Read-Field $savedSettings 'appCheckIntervalMinutes')
        plugins=@((Read-Field $configuration 'plugins') | ForEach-Object {
            $installed = Read-Field $_ 'installed'
            [pscustomobject]@{id=(Read-Field $_ 'id'); enabled=(Read-Field $_ 'enabled'); version=(Read-Field $installed 'version')}
        })
    }
} catch { Note-Error 'settings-summary' 'Could not read or parse update settings.' }
Save-Report 'settings-summary.json' $settings

$eventSummary = @()
foreach ($logName in @('Application', 'Microsoft-Windows-Windows Defender/Operational', 'Microsoft-Windows-CodeIntegrity/Operational', 'Microsoft-Windows-AppLocker/EXE and DLL')) {
    try {
        $records = @(Get-WinEvent -FilterHashtable @{LogName=$logName; StartTime=$Since} -MaxEvents 1000 -ErrorAction Stop)
        $matching = @($records | Where-Object { $_.Message -match 'ChordControl|Chord Control|chord-control|plugin-controller' } | ForEach-Object {
            [pscustomobject]@{TimeCreated=$_.TimeCreated.ToUniversalTime().ToString('o'); Id=$_.Id; ProviderName=$_.ProviderName; Message=(Protect-EventMessage $_.Message)}
        })
        $eventSummary += [pscustomobject]@{log=$logName; status='read'; scanned=$records.Count; events=$matching}
    } catch {
        $empty = $_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*'
        $eventSummary += [pscustomobject]@{log=$logName; status=$(if($empty){'no-events'}else{'unavailable'}); scanned=0; events=@()}
        if (-not $empty) { Note-Error $logName $_.Exception.Message }
    }
}
Save-Report 'events.json' @($eventSummary)
Save-Report 'collection.json' ([pscustomobject]@{
    format=1; collectedAt=(Get-Date).ToUniversalTime().ToString('o'); since=$Since.ToUniversalTime().ToString('o')
    timeZone=[TimeZoneInfo]::Local.Id; os=[Environment]::OSVersion.VersionString; is64BitProcess=[Environment]::Is64BitProcess
    logs=@($copiedLogs); guardActive=(Test-Path -LiteralPath (Join-Path $updateData 'guard\run')); errors=@($collectionErrors.ToArray())
})
$archive = $collectionPath + '.zip'
Compress-Archive -Path (Join-Path $collectionPath '*') -DestinationPath $archive -CompressionLevel Optimal
Write-Output $archive
