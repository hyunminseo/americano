$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $PSScriptRoot 'ACTIVATES.md'
$failed = $false
$count = 0

if (-not (Test-Path -LiteralPath $source)) {
  throw 'ACTIVATES.md was not found.'
}

foreach ($line in Get-Content -LiteralPath $source -Encoding UTF8) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  if ($line -notmatch '^\s*(\S+)\s+([0-9A-Fa-f:-]{17})\s+(\S+)\s*$') {
    Write-Host "Invalid entry: $line"
    $failed = $true
    continue
  }

  $name = $Matches[1]
  $mac = $Matches[2]
  $date = $Matches[3]
  if ($date -match '^\d{4}-\d{2}-\d{2}$') {
    $expires = "${date}T23:59:59.999Z"
  } elseif ([string]::IsNullOrWhiteSpace($date)) {
    $expires = [DateTime]::UtcNow.AddMonths(1).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  } else {
    $expires = $date
  }

  $safeName = $name -replace '[<>:"/\\|?*]', '_'
  $output = Join-Path $root "active_codes\license-$safeName.lic"
  Write-Host "Issued to: $name | MAC: $mac | Expires: $expires"
  & node (Join-Path $root 'scripts\license-issuer.cjs') issue --mac $mac --to $name --expires $expires --out $output
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed: $name | $mac"
    $failed = $true
  } else {
    $count++
  }
}

if ($count -eq 0) { throw 'No licenses were created.' }
if ($failed) { exit 1 }