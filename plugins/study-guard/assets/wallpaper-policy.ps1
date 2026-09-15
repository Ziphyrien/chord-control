$ErrorActionPreference = 'Stop'
$policyRequest = [Console]::In.ReadToEnd() | ConvertFrom-Json
$policyTest = $env:CHORD_CONTROL_NATIVE_TEST -eq '1' -and $policyRequest.testRoot -match '^Software\\ChordControl\\Tests\\[a-zA-Z0-9-]+$'
$policyPrefix = if ($policyTest) { $policyRequest.testRoot + '\' } else { '' }
$policyBackup = Join-Path $policyRequest.dataDir 'wallpaper-policy-backup.json'
$policyLease = Join-Path $policyRequest.dataDir 'wallpaper-policy-owner.txt'
$policyWallpaper = Join-Path $policyRequest.dataDir 'study-wallpaper.jpg'
function Read-PolicyValue($path, $name) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path)
  try {
    if ($null -eq $key -or $key.GetValueNames() -notcontains $name) { return @{ path=$path; name=$name; present=$false } }
    return @{ path=$path; name=$name; present=$true; kind=$key.GetValueKind($name).ToString(); value=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
  } finally { if ($key) { $key.Dispose() } }
}
function Write-PolicyValue($entry) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($entry.path)
  try {
    if (-not $entry.present) { $key.DeleteValue($entry.name,$false); return }
    $value = $entry.value
    switch ($entry.kind) { 'DWord' { $value=[int]$value } 'QWord' { $value=[long]$value } 'Binary' { $value=[byte[]]$value } 'MultiString' { $value=[string[]]$value } }
    $key.SetValue($entry.name,$value,[Microsoft.Win32.RegistryValueKind]::$($entry.kind))
  } finally { $key.Dispose() }
}
function Same-PolicyValue($left, $right) { return $left.present -eq $right.present -and $left.kind -eq $right.kind -and ($left.value | ConvertTo-Json -Compress) -eq ($right.value | ConvertTo-Json -Compress) }
if (-not $policyTest) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class StudyWallpaper {
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool SystemParametersInfo(uint action,uint param,string value,uint flags);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool SystemParametersInfo(uint action,uint param,StringBuilder value,uint flags);
 public static string Get() { var buffer=new StringBuilder(32768); if(!SystemParametersInfo(0x73,32768,buffer,0)) throw new System.ComponentModel.Win32Exception(); return buffer.ToString(); }
 public static void Set(string path) { if(!SystemParametersInfo(0x14,0,path,3)) throw new System.ComponentModel.Win32Exception(); }
}
'@
}
if ($policyRequest.action -eq 'restore') {
  if (-not (Test-Path -LiteralPath $policyBackup) -or -not (Test-Path -LiteralPath $policyLease)) { exit 0 }
  if ([IO.File]::ReadAllText($policyLease) -ne $policyRequest.owner) { exit 0 }
  $saved = Get-Content -LiteralPath $policyBackup -Raw | ConvertFrom-Json
  foreach ($entry in $saved.entries) { if (Same-PolicyValue (Read-PolicyValue $entry.installed.path $entry.installed.name) $entry.installed) { Write-PolicyValue $entry.original } }
  if (-not $policyTest -and [StudyWallpaper]::Get() -eq $saved.wallpaper) { [StudyWallpaper]::Set($saved.originalWallpaper) }
  Remove-Item -LiteralPath $policyBackup,$policyLease -Force
  Remove-Item -LiteralPath $policyWallpaper -Force -ErrorAction SilentlyContinue
  exit 0
}
if ($policyRequest.action -ne 'apply') { throw 'Unknown wallpaper policy action' }
New-Item -ItemType Directory -Path $policyRequest.dataDir -Force | Out-Null
if (-not $policyTest) {
  Add-Type -AssemblyName System.Drawing
  $image = [System.Drawing.Image]::FromFile($policyRequest.wallpaper)
  try { $image.Save($policyWallpaper,[System.Drawing.Imaging.ImageFormat]::Jpeg) } finally { $image.Dispose() }
}
$definitions = @(
  @('Software\Microsoft\Windows\CurrentVersion\Policies\ActiveDesktop','NoChangingWallPaper','DWord',1),
  @('Software\Microsoft\Windows\CurrentVersion\Policies\System','Wallpaper','String',$policyWallpaper),
  @('Software\Microsoft\Windows\CurrentVersion\Policies\System','WallpaperStyle','String','4'),
  @('Control Panel\Desktop','WallpaperStyle','String','10'),
  @('Control Panel\Desktop','TileWallpaper','String','0')
)
$entries = @($definitions | ForEach-Object { $path=$policyPrefix + $_[0]; @{ original=(Read-PolicyValue $path $_[1]); installed=@{path=$path;name=$_[1];kind=$_[2];value=$_[3];present=$true} } })
$originalWallpaper = if ($policyTest) { '' } else { [StudyWallpaper]::Get() }
$createdBackup = -not (Test-Path -LiteralPath $policyBackup)
if ($createdBackup) { @{ entries=$entries; originalWallpaper=$originalWallpaper; wallpaper=$policyWallpaper } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $policyBackup -Encoding UTF8 }
try {
  foreach ($entry in $entries) { Write-PolicyValue $entry.installed }
  if (-not $policyTest) { [StudyWallpaper]::Set($policyWallpaper) }
  [IO.File]::WriteAllText($policyLease,$policyRequest.owner)
} catch {
  foreach ($entry in $entries) { Write-PolicyValue $entry.original }
  if (-not $policyTest) { [StudyWallpaper]::Set($originalWallpaper) }
  if ($createdBackup) { Remove-Item -LiteralPath $policyBackup -Force }
  throw
}
