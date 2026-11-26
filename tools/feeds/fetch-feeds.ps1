<#
  Market feeds: reads public CBN and FMDQ data and adds anything new to Firestore.

  Runs twice each weekday in GitHub Actions (.github/workflows/market-feeds.yml); can also be run by hand:
    powershell -ExecutionPolicy Bypass -File tools/feeds/fetch-feeds.ps1 [-DryRun]

  Feeds (each records its outcome in feedStatus/<feed>, which drives the stale-feed alert in the app):
    cbn_ntb  NTB primary auctions     https://www.cbn.gov.ng/api/GetAllSecuritiesNTB
    cbn_omo  OMO auctions             https://www.cbn.gov.ng/api/GetAllSecuritiesOMO
    cbn_mpc  MPR and latest communique https://www.cbn.gov.ng/api/GetMPR_TOP, GetMpcTOP
    cbn_cpi  Headline inflation        https://www.cbn.gov.ng/api/GetInflationRatesTOP
    fmdq_cp  CP quotation notices      https://fmdqgroup.com/wp-json/wp/v2/posts
    news     Money-market news         Nairametrics and BusinessDay RSS (filtered), CBN circulars (GetAllCirculars)

  Only adds documents that don't exist yet, so manual entries and edits made in the app are never overwritten.
  Writes only public market data; reads nothing from the portfolio. Rates are stored as fractions in strings.
  Kept ASCII-only so Windows PowerShell 5.1 and PowerShell 7 read it the same way.
#>
param(
  [string]$Since = '2021-01-01',     # oldest auction to keep
  [int]$CpDays = 120,                # how far back to pick up CP notices
  [int]$NewsDays = 30,               # how far back to pick up news and CBN circulars
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Project = 'abud-24577'
$ApiKey = 'AIzaSyA_kaAFZtElUvI5kW3OGBAgCIj7_8az0rU'   # public web client key (same as src/app/firebase.js)
$DocRoot = "projects/$Project/databases/(default)/documents"
$Base = "https://firestore.googleapis.com/v1/$DocRoot"
$Headers = @{ 'User-Agent' = 'Mozilla/5.0 (compatible; market-data-feed)' }
$Inv = [Globalization.CultureInfo]::InvariantCulture
$Naira = [string][char]0x20A6
$script:Failed = 0

function Get-Json([string]$Url) { Invoke-RestMethod -Uri $Url -Headers $Headers -TimeoutSec 90 }

function Get-ExistingIds([string]$Coll) {
  $ids = New-Object 'System.Collections.Generic.HashSet[string]'
  $token = ''
  do {
    $url = "$Base/${Coll}?pageSize=300&mask.fieldPaths=date&key=$ApiKey"
    if ($token) { $url += "&pageToken=$token" }
    try { $r = Invoke-RestMethod -Uri $url -TimeoutSec 60 } catch { if ($DryRun) { Write-Warning "Could not list $Coll (rules not published?); dry run treats it as empty"; return , $ids }; throw }
    foreach ($d in @($r.documents)) { if ($d) { [void]$ids.Add(($d.name -split '/')[-1]) } }
    $token = $r.nextPageToken
  } while ($token)
  , $ids
}

function ConvertTo-Fields($Data) {
  $f = [ordered]@{}
  foreach ($k in $Data.Keys) {
    $v = $Data[$k]
    if ($v -is [bool]) { $f[$k] = @{ booleanValue = $v }; continue }
    if ($null -eq $v -or [string]$v -eq '') { continue }
    $f[$k] = @{ stringValue = [string]$v }
  }
  $f
}

function Send-Json([string]$Method, [string]$Url, $Body) {
  $json = $Body | ConvertTo-Json -Depth 12
  Invoke-RestMethod -Method $Method -Uri $Url -Body ([Text.Encoding]::UTF8.GetBytes($json)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 90 | Out-Null
}

# Creates documents that don't exist yet, 400 per commit. $Docs: list of @{ id; data }.
function Add-Docs([string]$Coll, $Docs) {
  if ($DryRun -or $Docs.Count -eq 0) { return }
  for ($i = 0; $i -lt $Docs.Count; $i += 400) {
    $writes = New-Object System.Collections.Generic.List[object]
    foreach ($d in $Docs[$i..([Math]::Min($i + 399, $Docs.Count - 1))]) {
      $writes.Add(@{ update = @{ name = "$DocRoot/$Coll/$($d.id)"; fields = (ConvertTo-Fields $d.data) }; currentDocument = @{ exists = $false } })
    }
    Send-Json 'Post' "${Base}:commit?key=$ApiKey" @{ writes = $writes.ToArray() }
  }
}

function Set-FeedStatus([string]$Feed, $Fields) {
  if ($DryRun) { return }
  $mask = ($Fields.Keys | ForEach-Object { "updateMask.fieldPaths=$_" }) -join '&'
  Send-Json 'Patch' "$Base/feedStatus/${Feed}?$mask&key=$ApiKey" @{ fields = (ConvertTo-Fields $Fields) }
}

function Invoke-Feed([string]$Feed, [scriptblock]$Work) {
  $now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ', $Inv)
  try {
    $result = & $Work
    $fields = [ordered]@{ feed = $Feed; lastRunAt = $now; lastSuccessAt = $now; added = [string]$result.added }
    if ($result.value) { $fields.value = $result.value }
    Set-FeedStatus $Feed $fields
    Write-Host ("{0}: {1} new{2}" -f $Feed, $result.added, $(if ($DryRun) { ' (dry run, nothing written)' } else { '' }))
  } catch {
    $msg = $_.Exception.Message
    if ($msg.Length -gt 300) { $msg = $msg.Substring(0, 300) }
    try { Set-FeedStatus $Feed ([ordered]@{ feed = $Feed; lastRunAt = $now; lastError = $msg; lastErrorAt = $now }) } catch { Write-Warning "Could not record the failure: $($_.Exception.Message)" }
    Write-Warning "${Feed} failed: $msg"
    $script:Failed++
  }
}

function Format-Fraction([decimal]$Percent) { ($Percent / 100).ToString('0.##########', $Inv) }
function Format-Plain([string]$S) { if (-not $S) { return '' }; $d = [decimal]::Parse($S, $Inv); if ($d -eq 0) { return '' }; $d.ToString('0.##', $Inv) }

# ---------- CBN auctions (NTB, OMO) ----------
function Sync-Auctions([string]$Kind, [string]$Endpoint) {
  $existing = Get-ExistingIds 'auctions'
  $rows = Get-Json "https://www.cbn.gov.ng/api/$Endpoint"
  $new = @{}
  foreach ($a in @($rows)) {
    try {
      if ($Kind -eq 'ntb' -and $a.auction -and $a.auction -notmatch 'Primary') { continue }
      $date = [datetime]::ParseExact(([string]$a.auctionDate).Trim(), 'MMMM-dd-yyyy', $Inv).ToString('yyyy-MM-dd')
      if ($date -lt $Since) { continue }
      if (-not ([string]$a.tenor -match '(\d+)')) { continue }
      $tenor = [string][int]$Matches[1]
      $rate = [decimal]::Parse([string]$a.rate, $Inv)
      if ($rate -le 0) { continue }
      $id = "$Kind-$date-$tenor"
      if ($existing.Contains($id) -or $new.ContainsKey($id)) { continue }
      $data = [ordered]@{
        kind = $Kind; date = $date; tenorDays = $tenor; stopRate = (Format-Fraction $rate)
        offeredM = (Format-Plain $a.amtOffered); subscribedM = (Format-Plain $a.totalSubscription); allottedM = (Format-Plain $a.totalSuccessful)
        source = 'CBN'; sourceUrl = 'https://www.cbn.gov.ng/rates/GovtSecurities.html'
      }
      $ty = 0; if ([decimal]::TryParse([string]$a.trueYield, [Globalization.NumberStyles]::Number, $Inv, [ref]$ty) -and $ty -gt 0) { $data.trueYield = Format-Fraction $ty }
      if ($a.maturityDate) { try { $data.maturityDate = [datetime]::ParseExact(([string]$a.maturityDate).Trim(), 'MMMM-dd-yyyy', $Inv).ToString('yyyy-MM-dd') } catch { } }
      $new[$id] = @{ id = $id; data = $data }
    } catch { Write-Warning "Skipped a $Kind row ($($a.auctionDate) $($a.tenor)): $($_.Exception.Message)" }
  }
  $list = @($new.Values | Sort-Object { $_.id })
  Add-Docs 'auctions' $list
  @{ added = $list.Count }
}

# ---------- CBN MPR and the latest MPC communique ----------
function Sync-Mpc {
  $existing = Get-ExistingIds 'mpc'
  $mpr = @(Get-Json 'https://www.cbn.gov.ng/api/GetMPR_TOP')[0].mpr
  $com = @(Get-Json 'https://www.cbn.gov.ng/api/GetMpcTOP') | Where-Object { $_.title -match 'Communiqu' } | Select-Object -First 1
  if (-not $mpr -or -not $com) { throw 'MPR or communique not found in the CBN response' }
  if (-not ([string]$com.documentDate -match '(\d{1,2})/(\d{1,2})/(\d{4})')) { throw "Unrecognised communique date: $($com.documentDate)" }
  $date = '{0}-{1:D2}-{2:D2}' -f $Matches[3], [int]$Matches[2], [int]$Matches[1]
  if ($existing.Contains($date)) { return @{ added = 0 } }
  $url = 'https://www.cbn.gov.ng' + (([string]$com.link) -replace ' ', '%20')
  Add-Docs 'mpc' @(@{ id = $date; data = [ordered]@{ date = $date; mpr = (Format-Fraction ([decimal]::Parse([string]$mpr, $Inv))); title = [string]$com.title; sourceUrl = $url; source = 'CBN' } })
  @{ added = 1 }
}

# ---------- CBN headline inflation (latest value only) ----------
function Sync-Cpi {
  $v = @(Get-Json 'https://www.cbn.gov.ng/api/GetInflationRatesTOP')[0].allItemsYearOn
  if (-not $v) { throw 'Inflation rate not found in the CBN response' }
  @{ added = 0; value = (Format-Fraction ([decimal]::Parse([string]$v, $Inv))) }
}

# ---------- FMDQ commercial paper quotation notices ----------
function Get-Issuer([string]$Title) {
  $t = $Title -replace [char]0x2019, "'"
  if ($t -match "Quotation of (.+?)'s ") { return $Matches[1].Trim() }
  if ($t -match "Approves (.+?)'s ") { return $Matches[1].Trim() }
  if ($t -match '^(?:.*, )?(.+?) Quotes ') { return $Matches[1].Trim() }
  if ($t -match '^(.+?) Series ') { return $Matches[1].Trim() }
  ''
}
function Sync-Cp {
  $existing = Get-ExistingIds 'cpQuotes'
  $after = (Get-Date).AddDays(-$CpDays).ToString('yyyy-MM-dd')
  $posts = Get-Json "https://fmdqgroup.com/wp-json/wp/v2/posts?search=commercial%20paper&per_page=50&after=${after}T00:00:00&_fields=id,date,title,link"
  $list = New-Object System.Collections.Generic.List[object]
  foreach ($p in @($posts)) {
    $title = [System.Net.WebUtility]::HtmlDecode([string]$p.title.rendered)
    if ($title -notmatch '(?i)commercial paper|\bCPs?\b|CPs-Q') { continue }
    $id = "fmdq-$($p.id)"
    if ($existing.Contains($id)) { continue }
    $size = ''
    if ($title -match ([regex]::Escape($Naira) + '\s?([\d.,]+)\s?Billion')) { $size = ([decimal]::Parse(($Matches[1] -replace ',', ''), $Inv) * 1000000000).ToString('0.00', $Inv) }
    $list.Add(@{ id = $id; data = [ordered]@{ date = ([string]$p.date).Substring(0, 10); title = $title; issuer = (Get-Issuer $title); size = $size; sourceUrl = [string]$p.link; confirmed = $false; source = 'FMDQ' } })
  }
  if ($DryRun) { foreach ($d in $list) { Write-Host ("  {0}  {1}  |  {2}" -f $d.data.date, $d.data.issuer, $d.data.size) } }
  Add-Docs 'cpQuotes' $list
  @{ added = $list.Count }
}

# ---------- Market news: Nairametrics and BusinessDay RSS (money-market topics only) and CBN circulars ----------
$NewsTopics = '(?i)treasury bill|t-bill|\bNTB|\bOMO\b|\bMPC\b|monetary policy|\bMPR\b|commercial paper|\bFMDQ\b|inflation|money market|interbank|\byields?\b|\bbonds?\b|\bDMO\b|Access Holdings|Access Bank|CBN|Central Bank'
function Get-NewsId([string]$Url) {
  $sha = [Security.Cryptography.SHA1]::Create()
  $hash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Url))
  'news-' + (($hash[0..7] | ForEach-Object { $_.ToString('x2') }) -join '')
}
function Sync-News {
  $existing = Get-ExistingIds 'news'
  $after = (Get-Date).AddDays(-$NewsDays).ToString('yyyy-MM-dd')
  $list = New-Object System.Collections.Generic.List[object]
  $seen = New-Object 'System.Collections.Generic.HashSet[string]'
  $add = {
    param($date, $title, $url, $source)
    if (-not $url -or $date -lt $after) { return }
    $id = Get-NewsId $url
    if ($existing.Contains($id) -or -not $seen.Add($id)) { return }
    $list.Add(@{ id = $id; data = [ordered]@{ date = $date; title = $title.Trim(); url = $url; source = $source } })
  }
  $errors = @()
  foreach ($feed in @(@{ url = 'https://nairametrics.com/feed/'; source = 'Nairametrics' }, @{ url = 'https://businessday.ng/feed/'; source = 'BusinessDay' })) {
    try {
      [xml]$rss = (Invoke-WebRequest -Uri $feed.url -Headers $Headers -UseBasicParsing -TimeoutSec 90).Content
      foreach ($item in $rss.rss.channel.item) {
        $title = [Net.WebUtility]::HtmlDecode([string]$item.title)
        $cats = (@($item.category) | ForEach-Object { if ($_ -is [string]) { $_ } else { $_.InnerText } }) -join ' '
        if ("$title $cats" -notmatch $NewsTopics) { continue }
        $date = ([datetime]::Parse([string]$item.pubDate, $Inv)).ToUniversalTime().ToString('yyyy-MM-dd')
        & $add $date $title ([string]$item.link) $feed.source
      }
    } catch { $errors += "$($feed.source): $($_.Exception.Message)" }
  }
  try {
    $circulars = Get-Json 'https://www.cbn.gov.ng/api/GetAllCirculars'   # assign first: PS 5.1 returns the array unenumerated
    foreach ($c in $circulars) {
      if (-not $c.documentDate -or $c.documentDate -notmatch '^(\d{2})/(\d{2})/(\d{4})$') { continue }
      $date = "$($Matches[3])-$($Matches[2])-$($Matches[1])"
      $link = 'https://www.cbn.gov.ng' + ([string]$c.link -replace ' ', '%20')
      & $add $date ('CBN circular: ' + ([string]$c.title).Trim()) $link 'CBN'
    }
  } catch { $errors += "CBN circulars: $($_.Exception.Message)" }
  foreach ($e in $errors) { Write-Warning "news source skipped: $e" }
  if ($errors.Count -eq 3) { throw ($errors -join '; ') }
  if ($DryRun) { foreach ($d in $list) { Write-Host ("  {0}  {1}  |  {2}" -f $d.data.date, $d.data.source, $d.data.title) } }
  Add-Docs 'news' $list
  @{ added = $list.Count }
}

Invoke-Feed 'cbn_ntb' { Sync-Auctions 'ntb' 'GetAllSecuritiesNTB' }
Invoke-Feed 'cbn_omo' { Sync-Auctions 'omo' 'GetAllSecuritiesOMO' }
Invoke-Feed 'cbn_mpc' { Sync-Mpc }
Invoke-Feed 'cbn_cpi' { Sync-Cpi }
Invoke-Feed 'fmdq_cp' { Sync-Cp }
Invoke-Feed 'news' { Sync-News }

if ($script:Failed -gt 0) { Write-Warning "$($script:Failed) feed(s) failed; the app shows them on the Market screen."; exit 1 }
