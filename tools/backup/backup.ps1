<#
  Exports every ABUD Firestore collection over the REST API into one JSON file, in the format Settings > Backup
  reads for a restore: { app, takenAt, collections: { name: [ { id, ...fields } ] } }.
  Usage: pwsh tools/backup/backup.ps1 [-Out backup]
  Read access only (the Firestore rules allow public reads). ASCII only.
#>
param([string]$Out = 'backup')
$ErrorActionPreference = 'Stop'
$base = 'https://firestore.googleapis.com/v1/projects/abud-24577/databases/(default)/documents'
$key = 'AIzaSyA_kaAFZtElUvI5kW3OGBAgCIj7_8az0rU'
$collections = @('transactions', 'instruments', 'mandateTerms', 'funds', 'fundPrices', 'audit', 'settings', 'quarterlyResults',
  'auctions', 'mpc', 'cpQuotes', 'feedStatus', 'invoices', 'counterparties', 'ratings', 'limitSets', 'news', 'auctionCalendar')

function Convert-Value($v) {
  $p = $v.PSObject.Properties | Select-Object -First 1
  switch ($p.Name) {
    'stringValue' { return $p.Value }
    'booleanValue' { return [bool]$p.Value }
    'integerValue' { return [long]$p.Value }
    'doubleValue' { return [double]$p.Value }
    'timestampValue' { return [string]$p.Value }
    'nullValue' { return $null }
    'mapValue' {
      $o = [ordered]@{}
      if ($p.Value.fields) { foreach ($f in $p.Value.fields.PSObject.Properties) { $o[$f.Name] = Convert-Value $f.Value } }
      return $o
    }
    'arrayValue' { return @(@($p.Value.values) | Where-Object { $_ } | ForEach-Object { Convert-Value $_ }) }
    default { return $null }
  }
}

$all = [ordered]@{}
$total = 0
foreach ($c in $collections) {
  $docs = New-Object System.Collections.Generic.List[object]
  $token = ''
  do {
    $url = "$base/$c" + "?key=$key&pageSize=300"
    if ($token) { $url += '&pageToken=' + [Uri]::EscapeDataString($token) }
    try { $res = Invoke-RestMethod -Uri $url -Method Get } catch { Write-Host "$c skipped: $($_.Exception.Message)"; break }
    foreach ($d in @($res.documents)) {
      if (-not $d) { continue }
      $o = [ordered]@{ id = ($d.name -split '/')[-1] }
      if ($d.fields) { foreach ($f in $d.fields.PSObject.Properties) { $o[$f.Name] = Convert-Value $f.Value } }
      $docs.Add([pscustomobject]$o)
    }
    $token = $res.nextPageToken
  } while ($token)
  $all[$c] = $docs.ToArray()
  $total += $docs.Count
  Write-Host ("{0,-18} {1,6}" -f $c, $docs.Count)
}
New-Item -ItemType Directory -Force $Out | Out-Null
$stamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
$file = Join-Path $Out ('abud-backup-' + [DateTime]::UtcNow.ToString('yyyy-MM-dd') + '.json')
$json = [pscustomobject]@{ app = 'ABUD Portfolio'; takenAt = $stamp; collections = [pscustomobject]$all } | ConvertTo-Json -Depth 20 -Compress
[IO.File]::WriteAllText((Join-Path (Resolve-Path $Out).Path (Split-Path $file -Leaf)), $json, (New-Object Text.UTF8Encoding $false))
Write-Host "Saved $total documents to $file"
