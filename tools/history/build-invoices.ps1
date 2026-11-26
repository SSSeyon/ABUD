<#
  Builds data/invoices-mcm.json: the fees MBO billed each quarter, from the "MCM income" sheet of the ABUD schedule.
  Usage: powershell -ExecutionPolicy Bypass -File tools/history/build-invoices.ps1 -Workbook "<path to xlsx>"

  Columns read (rows 5 onward, one per quarter end): C date, D days, J income for the quarter (naira),
  K WATBR return (the shadow benchmark income), M incentive, P management fee, R total.
  The app's back-test (#/backtest) loads this file into the invoices collection.
#>
param(
  [Parameter(Mandatory = $true)][string]$Workbook,
  [string]$Out
)
$ErrorActionPreference = 'Stop'
if (-not $Out) { $Out = Join-Path $PSScriptRoot '..\..\data\invoices-mcm.json' }
$inv = [Globalization.CultureInfo]::InvariantCulture

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

$rows = Read-Sheet 'MCM income'
$list = New-Object System.Collections.Generic.List[object]
foreach ($r in $rows) {
  if ($r.row -lt 5) { continue }
  $serial = Num $r.c[3]; $days = Num $r.c[4]; $mgmt = Num $r.c[16]
  if ($null -eq $serial -or $null -eq $days -or $null -eq $mgmt -or $mgmt -eq 0) { continue }
  $end = Iso ([int]$serial)
  $month = [int]$end.Substring(5, 2)
  $label = '{0}Q{1}' -f $end.Substring(0, 4), ([math]::Floor(($month - 1) / 3) + 1)
  $incentive = Num $r.c[13]; if ($null -eq $incentive) { $incentive = [decimal]0 }
  $fields = @(
    @('id', $label), @('quarter', $label), @('periodEnd', $end), @('days', ([int]$days).ToString()),
    @('mgmtFee', (Money $mgmt)), @('incentiveFee', (Money $incentive)), @('totalFee', (Money ($mgmt + $incentive))),
    @('sheetIncome', (Money (Num $r.c[10]))), @('sheetBenchmarkIncome', (Money (Num $r.c[11]))),
    @('source', 'MCM income sheet, ABUD Schedule 30.09.2026')
  )
  $list.Add('  {' + (($fields | ForEach-Object { '"' + $_[0] + '": "' + $_[1] + '"' }) -join ', ') + '}')
  Write-Host ('{0}  {1,16}  {2,16}' -f $label, (Money $mgmt), (Money $incentive))
}
Remove-Item -Recurse -Force $tmp
$json = "[`n" + ($list -join ",`n") + "`n]`n"
$path = Join-Path (Resolve-Path (Split-Path $Out)).Path (Split-Path $Out -Leaf)
[IO.File]::WriteAllText($path, $json)
"Wrote $($list.Count) quarters to $path"
