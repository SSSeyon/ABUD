<#
  Market feeds: reads public CBN and FMDQ data and adds anything new to Firestore.

  Runs twice each weekday in GitHub Actions (.github/workflows/market-feeds.yml); can also be run by hand:
    powershell -ExecutionPolicy Bypass -File tools/feeds/fetch-feeds.ps1 [-DryRun]

  Feeds (each records its outcome in feedStatus/<feed>, which drives the stale-feed alert in the app):
    cbn_ntb  NTB primary auctions     https://www.cbn.gov.ng/api/GetAllSecuritiesNTB
    cbn_omo  OMO auctions             https://www.cbn.gov.ng/api/GetAllSecuritiesOMO
    cbn_mpc  MPR and latest communique https://www.cbn.gov.ng/api/GetMPR_TOP, GetMpcTOP
    cbn_cpi  Headline inflation        https://www.cbn.gov.ng/api/GetInflationRatesTOP
    fmdq_cp  Commercial paper         FMDQ posts (quotations and programme registrations), plus Nairametrics and
                                      BusinessDay articles with commercial paper in the headline (WordPress REST search,
                                      all pages back $CpDays days). Each becomes an unconfirmed cpQuotes entry.
                                      (Proshare has no feed or API and its robots.txt disallows automated readers.)
    news     Money-market news         Nairametrics and BusinessDay RSS (filtered), CBN circulars (GetAllCirculars)

  Only adds documents that don't exist yet, so manual entries and edits made in the app are never overwritten.
  Writes only public market data; reads nothing from the portfolio. Rates are stored as fractions in strings.
  Kept ASCII-only so Windows PowerShell 5.1 and PowerShell 7 read it the same way.
#>
param(
  [string]$Since = '2021-01-01',     # oldest auction to keep
  [int]$CpDays = 730,                # how far back to pick up CP notices and articles
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
# Issuer from a news headline: "Veritasi offers 23% on N15 billion ...", "Dangote Cement's N100bn CP ...".
function Get-NewsIssuer([string]$Title) {
  $t = $Title -replace [char]0x2019, "'"
  # A short label before a colon ("Beyond traditional loans: ..."), with no figures in it, is not the issuer.
  if ($t -match '^([^:\d]{1,40}): ' -and ($Matches[1] -split ' ').Count -le 4 -and $Matches[1] -notmatch "(?i)'s|\b(offers|raises|launches)\b") { $t = $t.Substring($Matches[0].Length) }
  $verbs = 'offers|issues|raises|opens|launches|taps|lists|quotes|registers|secures|seeks|announces|plans|unveils|completes|closes|redeems|repays|pays off|prices|returns|floats|begins|gets|receives|commences|eyes|targets|records|executes|makes|delivers|strengthens|expands|pivots|approves|to issue|to raise'
  $i = ''
  if ($t -match "(?i)approves (?:the )?(?:quotation of )?(.+?)(?:'s)? (?:N|NGN|$([regex]::Escape($Naira)))\s?\d") { $i = $Matches[1] }
  elseif ($t -match "^(.+?)'s ") { $i = $Matches[1] }
  elseif ($t -match "^(.+?s)' ") { $i = $Matches[1] }
  elseif ($t -match "(?i)^(.+?) (?:successfully |quietly )?(?:$verbs)\b") { $i = $Matches[1] }
  else { $i = Get-Issuer $t }
  # Too long or a phrase rather than a name ("Why commercial papers are ...", "Investors snap up X"): leave blank.
  if ($i -match '(?i)^(why|how|what|investors?|firm|real estate firm|largest|nigeria|ngx|fmdq|sec)\b' -or ($i -split ' ').Count -gt 5) { return '' }
  $i.Trim()
}
# A short key for matching the same issuer across sources ("Dangote Cement Plc" and "Dangote Cement" agree).
function Get-IssuerKey([string]$Issuer) {
  $w = ($Issuer.ToLowerInvariant() -replace "[^a-z0-9 ]", ' ' -split '\s+') | Where-Object { $_ -and $_ -notin @('limited', 'ltd', 'plc', 'nigeria', 'the', 'group', 'company', 'holdings', 'and') }
  (@($w) | Select-Object -First 2) -join ' '
}
# Naira size, yield and tenor when the headline states them.
function Get-CpTerms([string]$Title) {
  $out = @{ size = ''; yield = ''; tenorDays = '' }
  if ($Title -match ('(?i)(?:' + [regex]::Escape($Naira) + '|\bN|NGN)\s?([\d.,]+)\s?(billion|bn|million|m)\b')) {
    $num = $Matches[1]; $mult = if ($Matches[2].ToLowerInvariant().StartsWith('b')) { 1000000000 } else { 1000000 }
    try { $out.size = ([decimal]::Parse(($num -replace ',', '').TrimEnd('.'), $Inv) * $mult).ToString('0.00', $Inv) } catch { }
  }
  # Only a rate the headline gives as the CP's return ("offers 23%", "at 21.5%", "23% return"), between 5% and 40%.
  if ($Title -match '(?i)(?:offers?(?: up to)?|at|yields?(?: of)?|returns? of|coupon of|rate of)\s+(\d{1,2}(?:\.\d+)?)\s?(?:%|per ?cent)' -or
      $Title -match '(?i)(\d{1,2}(?:\.\d+)?)\s?(?:%|per ?cent)\s+(?:yield|return|rate|coupon|p\.a)') {
    $y = [decimal]::Parse($Matches[1], $Inv)
    if ($y -ge 5 -and $y -le 40) { $out.yield = ($y / 100).ToString('0.######', $Inv) }
  }
  if ($Title -match '(?i)\b(\d{2,3})[- ]days?\b') { $out.tenorDays = $Matches[1] }
  $out
}
# Every post from a WordPress site matching a search, newest first, back to $After (all pages).
function Get-WpPosts([string]$Site, [string]$Search, [string]$After) {
  $all = New-Object System.Collections.Generic.List[object]
  for ($page = 1; $page -le 40; $page++) {
    $url = "$Site/wp-json/wp/v2/posts?search=$([uri]::EscapeDataString($Search))&per_page=100&page=$page&after=${After}T00:00:00&orderby=date&_fields=id,date,title,link"
    try { $r = Get-Json $url } catch { if ($page -gt 1 -and "$($_.Exception.Message)" -match '400') { break }; throw }
    # Assign first, then foreach: PS 5.1 hands back a JSON array unenumerated.
    $n = 0
    foreach ($p in $r) { if ($p) { $all.Add($p); $n++ } }
    if ($n -lt 100) { break }
  }
  , $all
}
function Get-ExistingCp {
  $docs = New-Object System.Collections.Generic.List[object]
  $token = ''
  do {
    $url = "$Base/cpQuotes?pageSize=300&mask.fieldPaths=date&mask.fieldPaths=issuer&mask.fieldPaths=kind&key=$ApiKey"
    if ($token) { $url += "&pageToken=$token" }
    try { $r = Invoke-RestMethod -Uri $url -TimeoutSec 60 } catch { if ($DryRun) { return , $docs }; throw }
    foreach ($d in @($r.documents)) { if ($d) { $docs.Add(@{ id = ($d.name -split '/')[-1]; date = [string]$d.fields.date.stringValue; key = (Get-IssuerKey ([string]$d.fields.issuer.stringValue)); group = $(if ([string]$d.fields.kind.stringValue -eq 'redemption') { 'redemption' } else { 'offer' }) }) } }
    $token = $r.nextPageToken
  } while ($token)
  , $docs
}
function Sync-Cp {
  $known = Get-ExistingCp
  $ids = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($k in $known) { [void]$ids.Add($k.id) }
  $after = (Get-Date).AddDays(-$CpDays).ToString('yyyy-MM-dd')
  $list = New-Object System.Collections.Generic.List[object]
  # Same issuer within 30 days of an entry already held (or added this run): the same paper, so skip the article.
  # Keys agree when equal or one starts the other ("pivot" and "pivot integrated"); a redemption is never
  # the same story as an issue.
  $isDuplicate = {
    param($key, $date, $group)
    if (-not $key) { return $false }
    $d = [datetime]::ParseExact($date, 'yyyy-MM-dd', $Inv)
    foreach ($k in $known) {
      if (-not $k.key -or -not $k.date -or $k.group -ne $group) { continue }
      $same = $k.key -eq $key -or $k.key.StartsWith("$key ") -or $key.StartsWith("$($k.key) ")
      if ($same -and [Math]::Abs(([datetime]::ParseExact($k.date, 'yyyy-MM-dd', $Inv) - $d).TotalDays) -le 30) { return $true }
    }
    $false
  }
  $sources = @(
    @{ site = 'https://fmdqgroup.com'; prefix = 'fmdq'; source = 'FMDQ'; searches = @('commercial paper', 'CP programme') },
    @{ site = 'https://nairametrics.com'; prefix = 'nm'; source = 'Nairametrics'; searches = @('commercial paper') },
    @{ site = 'https://businessday.ng'; prefix = 'bd'; source = 'BusinessDay'; searches = @('commercial paper') }
  )
  $errors = @()
  foreach ($s in $sources) {
    try {
      foreach ($q in $s.searches) {
        foreach ($p in (Get-WpPosts $s.site $q $after)) {
          $title = [Net.WebUtility]::HtmlDecode([string]$p.title.rendered).Trim()
          if ($title -notmatch '(?i)commercial papers?|\bCPs?\b|CPs-Q') { continue }
          $id = "$($s.prefix)-$($p.id)"
          if ($ids.Contains($id)) { continue }
          $date = ([string]$p.date).Substring(0, 10)
          $issuer = if ($s.prefix -eq 'fmdq') { Get-Issuer $title } else { Get-NewsIssuer $title }
          $key = Get-IssuerKey $issuer
          $terms = Get-CpTerms $title
          # An article that names neither an amount nor a rate is commentary, not a paper to consider.
          if ($s.prefix -ne 'fmdq' -and -not $terms.size -and -not $terms.yield) { continue }
          $kind = if ($title -match '(?i)redeem|redemption|repay|pays? off|maturity|returns N|returns \S*bn to') { 'redemption' } elseif ($title -match '(?i)programme|program\b|registers|registration') { 'programme' } elseif ($s.prefix -eq 'fmdq') { 'quotation' } else { 'issue' }
          $group = if ($kind -eq 'redemption') { 'redemption' } else { 'offer' }
          if ($s.prefix -ne 'fmdq' -and (& $isDuplicate $key $date $group)) { continue }
          [void]$ids.Add($id)
          $list.Add(@{ id = $id; key = $key; data = [ordered]@{ date = $date; title = $title; issuer = $issuer; size = $terms.size; yield = $terms.yield; tenorDays = $terms.tenorDays; kind = $kind; sourceUrl = [string]$p.link; confirmed = $false; source = $s.source } })
          $known.Add(@{ id = $id; date = $date; key = $key; group = $group })
        }
      }
    } catch { $errors += "$($s.source): $($_.Exception.Message)" }
  }
  foreach ($e in $errors) { Write-Warning "CP source skipped: $e" }
  if ($errors.Count -eq $sources.Count) { throw ($errors -join '; ') }
  if ($DryRun) { foreach ($d in ($list | Sort-Object { $_.data.date } -Descending)) { Write-Host ("  {0}  {1,-12} {2,-9} {3,-28} {4,16} {5,6} {6,4}  {7}" -f $d.data.date, $d.data.source, $d.data.kind, $d.data.issuer, $d.data.size, $d.data.yield, $d.data.tenorDays, $d.data.title) } }
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
