<#
  Builds data/history-2026-09-30.json from tools/history/source.txt and the ABUD schedule workbook.
  Usage: powershell -ExecutionPolicy Bypass -File tools/history/build-history.ps1 -Workbook "<path to xlsx>"

  Reads from the workbook: the bank ledger and fee table ("Fees & Cash") and the daily fund yields
  ("Cowrywise App", "TrustBanc App"). Everything else comes from source.txt.
  Prints a reconciliation of the app's cash against the bank ledger, day by day, and the valuation at AsOf.
  All money arithmetic uses [decimal].
#>
param(
  [Parameter(Mandatory = $true)][string]$Workbook,
  [int]$AsOf = 46295,
  [string]$Out
)
$ErrorActionPreference = 'Stop'
if (-not $Out) { $Out = Join-Path $PSScriptRoot '..\..\data\history-2026-09-30.json' }
$inv = [Globalization.CultureInfo]::InvariantCulture

# ---------- workbook reading ----------
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("abud-xlsx-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $tmp | Out-Null
Copy-Item $Workbook "$tmp\wb.zip"
Expand-Archive "$tmp\wb.zip" "$tmp\x"
$x = "$tmp\x"

[xml]$wbXml = Get-Content -Raw -Encoding UTF8 "$x\xl\workbook.xml"
[xml]$relXml = Get-Content -Raw -Encoding UTF8 "$x\xl\_rels\workbook.xml.rels"
$rels = @{}; foreach ($r in $relXml.Relationships.Relationship) { $rels[$r.Id] = $r.Target }
$sheetFile = @{}
foreach ($s in $wbXml.workbook.sheets.sheet) {
  $rid = $s.GetAttribute('id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
  $sheetFile[$s.name] = Join-Path "$x\xl" ($rels[$rid] -replace '/', '\')
}
[xml]$ssXml = Get-Content -Raw -Encoding UTF8 "$x\xl\sharedStrings.xml"
$strings = New-Object System.Collections.Generic.List[string]
foreach ($si in $ssXml.sst.si) { $strings.Add($si.InnerText) }

function ColIdx([string]$ref) { $n = 0; foreach ($ch in ($ref -replace '\d', '').ToCharArray()) { $n = $n * 26 + ([int]$ch - 64) }; $n }

# Returns rows as hashtables: @{ row = n; c = @{ colIndex = text } }
function Read-Sheet([string]$name) {
  $reader = [Xml.XmlReader]::Create($sheetFile[$name])
  $rows = New-Object System.Collections.Generic.List[object]
  $cur = $null
  while ($reader.Read()) {
    if ($reader.NodeType -ne 'Element') { continue }
    if ($reader.LocalName -eq 'row') { $cur = @{ row = [int]$reader.GetAttribute('r'); c = @{} }; $rows.Add($cur) }
    elseif ($reader.LocalName -eq 'c' -and -not $reader.IsEmptyElement) {
      $col = ColIdx $reader.GetAttribute('r'); $t = $reader.GetAttribute('t'); $v = $null
      $sub = $reader.ReadSubtree()
      while ($sub.Read()) {
        if ($sub.NodeType -eq 'Element' -and ($sub.LocalName -eq 'v' -or $sub.LocalName -eq 't')) { $v = $sub.ReadElementContentAsString() }
      }
      if ($null -ne $v) { if ($t -eq 's') { $v = $strings[[int]$v] }; $cur.c[$col] = $v }
    }
  }
  $reader.Close()
  return $rows
}

# Numeric cell or source field; null when blank or not a number (text, #DIV/0!).
function Num($s) {
  if ($null -eq $s -or "$s".Trim() -eq '') { return $null }
  $d = [decimal]0
  if ([decimal]::TryParse("$s", [Globalization.NumberStyles]::Float, $inv, [ref]$d)) { return $d }
  return $null
}
function Kobo([decimal]$d) { [decimal]::Round($d, 2, [MidpointRounding]::AwayFromZero) }
function Money([decimal]$d) { (Kobo $d).ToString('0.00', $inv) }
function Iso([int]$serial) { ([datetime]'1899-12-30').AddDays($serial).ToString('yyyy-MM-dd') }

# ---------- bank ledger and fee table ("Fees & Cash") ----------
$feesSheet = Read-Sheet 'Fees & Cash'
$ledger = @{}  # serial -> net change
foreach ($r in $feesSheet) {
  if ($r.row -lt 4) { continue }
  $d = Num $r.c[11]; if ($null -eq $d) { continue }
  $chg = [decimal]0
  $i = Num $r.c[12]; if ($null -ne $i) { $chg += $i }
  $o = Num $r.c[13]; if ($null -ne $o) { $chg += $o }
  $k = [int]$d; if (-not $ledger.ContainsKey($k)) { $ledger[$k] = [decimal]0 }; $ledger[$k] += $chg
}
$fees = New-Object System.Collections.Generic.List[object]
foreach ($r in $feesSheet) {
  if ($r.row -lt 4) { continue }
  $d = Num $r.c[2]; if ($null -eq $d) { continue }
  $amt = [decimal]0; $parts = @()
  foreach ($col in 4..7) { $v = Num $r.c[$col]; if ($null -ne $v) { $amt += $v } }
  if ($amt -eq 0) { continue }
  $desc = "$($r.c[3])".Trim(); if ($desc -eq '') { $desc = 'Bank charge' }
  $fees.Add(@{ date = [int]$d; amount = (Kobo $amt); notes = $desc })
}

# ---------- fund yields ----------
function Read-Yields([string]$sheet) {
  $list = New-Object System.Collections.Generic.List[object]; $prev = $null
  foreach ($r in (Read-Sheet $sheet)) {
    $d = Num $r.c[2]; $y = Num $r.c[6]
    if ($null -eq $d -or $null -eq $y) { continue }
    $y = [decimal]::Round($y, 6)
    if ($y -ne $prev) { $list.Add(@{ date = [int]$d; rate = $y }); $prev = $y }
  }
  return $list
}
$yields = @{ cowrywise = (Read-Yields 'Cowrywise App'); trustbanc = (Read-Yields 'TrustBanc App') }
function YieldOn([string]$fund, [int]$d) {
  $found = $null
  foreach ($p in $yields[$fund]) { if ($p.date -gt $d) { break }; $found = $p.rate }
  if ($null -eq $found) { throw "No yield for $fund on $(Iso $d)" }
  return $found
}
$consRows = Read-Sheet 'Consolidated Inv'
Remove-Item -Recurse -Force $tmp

# ---------- source ----------
$funds = [ordered]@{}; $inst = [ordered]@{}; $closes = @{}; $flows = New-Object System.Collections.Generic.List[object]
foreach ($line in Get-Content -Encoding UTF8 (Join-Path $PSScriptRoot 'source.txt')) {
  if ($line.Trim() -eq '' -or $line.TrimStart().StartsWith('#')) { continue }
  $f = $line.Split('|')
  switch ($f[0]) {
    'FUNDDEF' { $funds[$f[1]] = @{ key = $f[1]; name = $f[2]; managerName = $f[3] } }
    { $_ -in 'IN', 'WD', 'FEE' } {
      $type = @{ IN = 'inflow'; WD = 'withdrawal'; FEE = 'fee_debit' }[$f[0]]
      $flows.Add(@{ type = $type; date = [int]$f[1]; amount = (Num $f[2]); notes = $f[3] })
    }
    { $_ -in 'FD', 'CALL' } { $inst[$f[1]] = @{ key = $f[1]; type = $(if ($f[0] -eq 'CALL') { 'call_deposit' } else { 'fixed_deposit' }); counterpartyName = $f[2]; ref = $f[3]; valueDate = [int]$f[4]; costSpec = $f[5]; rate = $f[6]; gross = $f[7]; maturityDate = [int]$f[8]; notes = $f[9] } }
    'BILL' { $inst[$f[1]] = @{ key = $f[1]; type = $f[2]; counterpartyName = $f[3]; ref = $f[4]; valueDate = [int]$f[5]; costSpec = $f[6]; faceValue = (Num $f[7]); maturityDate = [int]$f[8]; discountRate = $f[9]; notes = $f[10] } }
    'FUND' { $inst[$f[1]] = @{ key = $f[1]; type = 'money_market_fund'; fundKey = $f[2]; ref = $f[3]; valueDate = [int]$f[4]; costSpec = $f[5]; notes = $f[6] } }
    'CLOSE' {
      if ($closes.ContainsKey($f[1])) { throw "Second close for $($f[1])" }
      $closes[$f[1]] = @{ key = $f[1]; date = [int]$f[2]; spec = $f[3]; notes = $f[4] }
    }
    default { throw "Unknown line: $line" }
  }
}

# ---------- amounts ----------
function Accrued($i, [int]$date) {
  $cost = $i.cost
  if ($i.type -in 'fixed_deposit', 'call_deposit') { return $cost + $cost * (Num $i.rate) * ($date - $i.valueDate) / 365 }
  if ($i.type -eq 'money_market_fund') {
    $acc = [decimal]0
    for ($d = $i.valueDate + 1; $d -le $date; $d++) { $acc += $cost * (YieldOn $i.fundKey $d) / 365 }
    return $cost + $acc
  }
  # discount instruments: amortised cost
  $total = $i.maturityDate - $i.valueDate
  return $cost + ($i.faceValue - $cost) * ($date - $i.valueDate) / $total
}

# Resolve costs and non-SOLVE closes; chained costs depend on earlier closes.
$pending = $true
while ($pending) {
  $pending = $false; $progress = $false
  foreach ($i in $inst.Values) {
    if ($null -eq $i.cost) {
      if ($i.costSpec -match '^ACC:(.+)([+-])([0-9.]+)$') {
        $prev = $closes[$Matches[1]]
        if ($null -eq $prev.amount) { $pending = $true; continue }
        $i.cost = if ($Matches[2] -eq '+') { $prev.amount + (Num $Matches[3]) } else { $prev.amount - (Num $Matches[3]) }
      } else { $i.cost = Num $i.costSpec }
      $progress = $true
    }
    $c = $closes[$i.key]
    if ($c -and $null -eq $c.amount -and $c.spec -ne 'SOLVE') {
      if ($c.spec -match '^ROLL:(\S+)(\s+([+-])([0-9.]+))?$') {
        # Rolled into another deal: proceeds equal that deal's principal, plus or minus cash paid in or out.
        $next = $inst[$Matches[1]]
        if (-not $next) { throw "$($i.key): ROLL target $($Matches[1]) not found" }
        if ($null -eq $next.cost) { $pending = $true; continue }
        $adj = if ($Matches[2]) { (Num $Matches[4]) * $(if ($Matches[3] -eq '+') { 1 } else { -1 }) } else { [decimal]0 }
        $c.amount = $next.cost + $adj
        $c.accruedGap = $c.amount - (Kobo (Accrued $i $c.date))
      } elseif ($c.spec -eq 'ACC') { $c.amount = Kobo (Accrued $i $c.date) }
      else { $c.amount = Num $c.spec }
      $progress = $true
    }
  }
  if ($pending -and -not $progress) { throw 'Unresolvable chained costs' }
}

# Cash effects per day, excluding SOLVE closes.
function Add-Day($map, [int]$d, [decimal]$v) { if (-not $map.ContainsKey($d)) { $map[$d] = [decimal]0 }; $map[$d] += $v }
function App-Cash {
  $m = @{}
  foreach ($t in $flows) { Add-Day $m $t.date ($(if ($t.type -eq 'inflow') { 1 } else { -1 }) * $t.amount) }
  foreach ($t in $fees) { Add-Day $m $t.date (-$t.amount) }
  foreach ($i in $inst.Values) { Add-Day $m $i.valueDate (-$i.cost) }
  foreach ($c in $closes.Values) { if ($null -ne $c.amount) { Add-Day $m $c.date $c.amount } }
  return $m
}
$solveDates = @{}
foreach ($c in $closes.Values) { if ($c.spec -eq 'SOLVE') { if ($solveDates.ContainsKey($c.date)) { throw "Two SOLVE closes on $(Iso $c.date)" }; $solveDates[$c.date] = $c } }
# SOLVE: proceeds that bring the app's cash balance at the end of that day level with the bank ledger's,
# so any gap built up before (cash left with a manager, register rounding) is folded into that close.
foreach ($d in ($solveDates.Keys | Sort-Object)) {
  $c = $solveDates[$d]
  $app = App-Cash
  $gap = [decimal]0
  foreach ($k in $ledger.Keys) { if ($k -le $d) { $gap += $ledger[$k] } }
  foreach ($k in $app.Keys) { if ($k -le $d) { $gap -= $app[$k] } }
  $c.amount = $gap
  $i = $inst[$c.key]
  Write-Host ("SOLVE {0} on {1}: {2:N2} (accrued value {3:N2})" -f $c.key, (Iso $d), $c.amount, (Kobo (Accrued $i $d)))
}
foreach ($c in $closes.Values) {
  if ($c.accruedGap -and [Math]::Abs($c.accruedGap) -ge 1000) { Write-Host ("ROLL {0} on {1}: rolled amount differs from accrued value by {2:N2}" -f $c.key, (Iso $c.date), $c.accruedGap) }
}
# Chained costs that depend on a SOLVE close are not supported (none in source).

# ---------- checks ----------
foreach ($i in $inst.Values) {
  if ($i.cost -le 0) { throw "$($i.key): cost must be positive" }
  $c = $closes[$i.key]
  if ($c) {
    if ($c.amount -le 0) { throw "$($i.key): close amount must be positive" }
    if ($c.date -lt $i.valueDate) { throw "$($i.key): closes before it opens" }
    if ($i.type -ne 'money_market_fund' -and $c.date -gt $i.maturityDate) { Write-Host "WARN $($i.key): closes $(Iso $c.date), after maturity $(Iso $i.maturityDate)" }
  }
  if ($i.type -ne 'money_market_fund' -and $i.maturityDate -le $i.valueDate) { throw "$($i.key): maturity not after value date" }
}

# ---------- reconciliation ----------
$app = App-Cash
$start = [int](@($ledger.Keys) + @($app.Keys) | Measure-Object -Minimum).Minimum
$appBal = [decimal]0; $ledBal = [decimal]0; $prevDiff = [decimal]0; $runStart = $null
Write-Host ''; Write-Host 'Cash vs bank ledger (periods where they differ):'
for ([int]$d = $start; $d -le $AsOf; $d++) {
  if ($app.ContainsKey($d)) { $appBal += $app[$d] }
  if ($ledger.ContainsKey($d)) { $ledBal += $ledger[$d] }
  $diff = Kobo ($appBal - $ledBal)
  if ($diff -ne $prevDiff) {
    if ($prevDiff -ne 0) { Write-Host ("  {0} to {1}: app {2,18:N2} vs ledger" -f (Iso $runStart), (Iso ($d - 1)), $prevDiff) }
    $runStart = $d; $prevDiff = $diff
  }
}
if ($prevDiff -ne 0) { Write-Host ("  {0} to {1}: app {2,18:N2} vs ledger (STILL OPEN)" -f (Iso $runStart), (Iso $AsOf), $prevDiff) }
Write-Host ("Cash at {0}: app {1:N2}, ledger {2:N2}" -f (Iso $AsOf), $appBal, $ledBal)

$holdings = [decimal]0
foreach ($i in $inst.Values) {
  $c = $closes[$i.key]
  $end = if ($c) { $c.date } elseif ($i.type -eq 'money_market_fund') { [int]::MaxValue } else { $i.maturityDate }
  if ($AsOf -ge $i.valueDate -and $AsOf -lt $end) {
    $v = Accrued $i $AsOf; $holdings += $v
    Write-Host ("  open: {0,-12} {1,18:N2}" -f $i.key, $v)
  }
}
Write-Host ("Holdings {0:N2}; NAV {1:N2}" -f $holdings, ($holdings + $appBal))

# Quarter-end NAV against the workbook ("Consolidated Inv" total balance, column J).
$wbNav = @{}
foreach ($r in $consRows) { $d = Num $r.c[2]; $v = Num $r.c[10]; if ($null -ne $d -and $null -ne $v) { $wbNav[[int]$d] = $v } }
$cashTo = @{}; $run = [decimal]0
for ([int]$d = $start; $d -le $AsOf; $d++) { if ($app.ContainsKey($d)) { $run += $app[$d] }; $cashTo[$d] = $run }
$quarters = New-Object System.Collections.Generic.List[object]
Write-Host ''; Write-Host 'Quarter-end NAV, app vs workbook:'
$q = [datetime]'2021-12-31'
while ($true) {
  $d = [int]($q - [datetime]'1899-12-30').TotalDays
  if ($d -gt $AsOf) { break }
  $h = [decimal]0
  foreach ($i in $inst.Values) {
    $c = $closes[$i.key]
    $end = if ($c) { $c.date } elseif ($i.type -eq 'money_market_fund') { [int]::MaxValue } else { $i.maturityDate }
    if ($d -ge $i.valueDate -and $d -lt $end) { $h += Accrued $i $d }
  }
  $nav = $cashTo[$d] + $h
  $wb = $wbNav[$d]
  Write-Host ("  {0}: app {1,18:N2}  workbook {2,18:N2}  diff {3,14:N2}" -f (Iso $d), $nav, $wb, ($nav - $wb))
  $quarters.Add([ordered]@{ date = (Iso $d); nav = (Money $nav); workbookNav = (Money $wb) })
  $q = $q.AddDays(1).AddMonths(3).AddDays(-1)
}

# ---------- output ----------
$outFunds = foreach ($fd in $funds.Values) { [ordered]@{ key = $fd.key; name = $fd.name; managerName = $fd.managerName; pricingBasis = 'yield'; isMboManaged = $false } }
$outPrices = foreach ($k in $yields.Keys | Sort-Object) { foreach ($p in $yields[$k]) { [ordered]@{ fundKey = $k; date = (Iso $p.date); priceOrYield = $p.rate.ToString('0.######', $inv) } } }
$outInst = foreach ($i in $inst.Values) {
  $o = [ordered]@{ key = $i.key; type = $i.type }
  if ($i.counterpartyName) { $o.counterpartyName = $i.counterpartyName }
  if ($i.type -eq 'money_market_fund') { $o.fundKey = $i.fundKey; $o.pricingBasis = 'yield' }
  $o.cost = Money $i.cost
  if ($i.faceValue) { $o.faceValue = Money $i.faceValue }
  if ($i.rate) { $o.rate = $i.rate }
  if ($i.discountRate) { $o.discountRate = $i.discountRate }
  $o.tradeDate = Iso $i.valueDate; $o.valueDate = Iso $i.valueDate
  if ($i.type -ne 'money_market_fund') { $o.maturityDate = Iso $i.maturityDate }
  $o
}
$txs = New-Object System.Collections.Generic.List[object]
foreach ($t in $flows) { $txs.Add([ordered]@{ type = $t.type; date = (Iso $t.date); amount = (Money $t.amount); notes = $t.notes }) }
foreach ($t in $fees) { $txs.Add([ordered]@{ type = 'fee_debit'; date = (Iso $t.date); amount = (Money $t.amount); notes = $t.notes }) }
foreach ($i in $inst.Values) {
  $note = $i.notes; if ($i.gross) { $note = (@($note, "Gross rate $([decimal]::Parse($i.gross, $inv) * 100)%, net of 10% WHT $([decimal]::Parse($i.rate, $inv) * 100)%") | Where-Object { $_ }) -join '. ' }
  $txs.Add([ordered]@{ type = $(if ($i.type -eq 'money_market_fund') { 'fund_subscription' } else { 'invest' }); date = (Iso $i.valueDate); amount = (Money $i.cost); instrumentKey = $i.key; reference = $i.ref; notes = $note })
  $c = $closes[$i.key]
  if ($c) { $txs.Add([ordered]@{ type = $(if ($i.type -eq 'money_market_fund') { 'fund_redemption' } else { 'mature' }); date = (Iso $c.date); amount = (Money $c.amount); instrumentKey = $i.key; reference = $i.ref; notes = $c.notes }) }
}
foreach ($t in $txs) { foreach ($k in @($t.Keys)) { if ($null -eq $t[$k] -or "$($t[$k])" -eq '') { $t.Remove($k) } } }
$sorted = $txs | Sort-Object { $_.date }, { @{ inflow = 0; mature = 1; fund_redemption = 2; invest = 3; fund_subscription = 4; withdrawal = 5; fee_debit = 6 }[$_.type] }

$doc = [ordered]@{
  asOf = (Iso $AsOf)
  source = 'ABUD Schedule 30.09.2026.xlsx, transcribed by tools/history/build-history.ps1'
  check = [ordered]@{ cash = (Money $appBal); ledgerCash = (Money $ledBal); holdings = (Money $holdings); nav = (Money ($holdings + $appBal)); quarterEnds = $quarters.ToArray() }
  funds = @($outFunds); fundPrices = @($outPrices); instruments = @($outInst); transactions = @($sorted)
}
New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
$json = $doc | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText([IO.Path]::GetFullPath($Out), $json, (New-Object Text.UTF8Encoding $false))
Write-Host ''; Write-Host ("Wrote {0}: {1} funds, {2} fund yields, {3} instruments, {4} transactions" -f $Out, @($outFunds).Count, @($outPrices).Count, @($outInst).Count, $txs.Count)
