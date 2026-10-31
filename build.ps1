<#
.SYNOPSIS
  Build Suno Shuffle for the Chrome Web Store.

.DESCRIPTION
  Copies only the files the extension needs into dist\suno-shuffle-<version>\, zips it,
  and (with -KeyPath) packs a signed .crx for Verified CRX Uploads.

.EXAMPLE
  .\build.ps1
  .\build.ps1 -KeyPath "C:\Development\Suno Shuffle PRIVATE KEY\privatekey.pem"
#>
param(
  [string]$KeyPath
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
$version = $manifest.version

# Everything the extension loads at runtime — nothing else ships.
$files = @(
  'manifest.json',
  'background.js',
  'content.js', 'content.css',
  'page-bridge.js',
  'popup.html', 'popup.js', 'popup.css',
  'icons\icon16.png', 'icons\icon48.png', 'icons\icon128.png'
)

# Sanity check: every file the manifest references must be in the list above.
$referenced = @($manifest.background.service_worker, $manifest.action.default_popup)
$referenced += $manifest.content_scripts | ForEach-Object { $_.js; $_.css }
$referenced += $manifest.icons.PSObject.Properties.Value
$referenced += $manifest.action.default_icon.PSObject.Properties.Value
foreach ($ref in ($referenced | Where-Object { $_ } | Sort-Object -Unique)) {
  $rel = $ref -replace '/', '\'
  if ($files -notcontains $rel) { throw "manifest.json references '$ref' but build.ps1 doesn't ship it" }
}

$dist = Join-Path $root 'dist'
$stage = Join-Path $dist "suno-shuffle-$version"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $stage 'icons') | Out-Null

foreach ($f in $files) {
  $src = Join-Path $root $f
  if (-not (Test-Path $src)) { throw "Missing file: $f" }
  Copy-Item $src (Join-Path $stage $f)
}

$zip = Join-Path $dist "suno-shuffle-$version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
Write-Host "Staged  $stage"
Write-Host "Zipped  $zip  ($([math]::Round((Get-Item $zip).Length / 1KB)) KB)"

if (-not $KeyPath) {
  Write-Host 'No -KeyPath given: skipped signing. Pass your privatekey.pem to build the .crx.'
  return
}

if (-not (Test-Path $KeyPath)) { throw "Key not found: $KeyPath" }

$chrome = @(
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw 'chrome.exe not found' }

# A throwaway profile keeps this separate from any Chrome window you have open.
$profileDir = Join-Path ([IO.Path]::GetTempPath()) "suno-shuffle-pack-$PID"
$crxOut = "$stage.crx"
if (Test-Path $crxOut) { Remove-Item $crxOut -Force }

$p = Start-Process -FilePath $chrome -PassThru -Wait -ArgumentList @(
  "--pack-extension=`"$stage`"",
  "--pack-extension-key=`"$KeyPath`"",
  "--user-data-dir=`"$profileDir`"",
  '--no-message-box', '--no-first-run'
)
Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue

if (-not (Test-Path $crxOut)) { throw "Chrome did not produce $crxOut (exit code $($p.ExitCode))" }
$final = Join-Path $dist "Suno Shuffle v$version.crx"
Move-Item $crxOut $final -Force
Write-Host "Signed  $final  ($([math]::Round((Get-Item $final).Length / 1KB)) KB)"
