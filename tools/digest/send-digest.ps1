<#
  Daily digest email. Renders digest.html in headless Chrome (the app's own alert, maturity and opportunity logic),
  then sends it by SMTP with curl. Run by .github/workflows/daily-digest.yml at 07:00 Lagos time.

  Usage: pwsh tools/digest/send-digest.ps1 [-Url http://localhost:8000/digest.html] [-DryRun]

  Settings come from environment variables (GitHub repository secrets):
    SMTP_URL   e.g. smtps://smtp.gmail.com:465 or smtp://smtp.office365.com:587
    SMTP_USER  mailbox login
    SMTP_PASS  password or app password
    DIGEST_FROM  sender address (defaults to SMTP_USER)
    DIGEST_TO    recipients, comma separated
  Without them (or with -DryRun) the digest is printed and saved to digest-out/, and nothing is sent.
  ASCII only, so it runs the same under Windows PowerShell 5.1 and pwsh.
#>
param(
  [string]$Url = 'http://localhost:8000/digest.html',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

function Find-Chrome {
  foreach ($c in @('google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser')) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  foreach ($p in @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  throw 'Chrome not found'
}

$chrome = Find-Chrome
$profileDir = Join-Path ([IO.Path]::GetTempPath()) ('abud-digest-' + [Guid]::NewGuid().ToString('N'))
$outDir = Join-Path (Get-Location) 'digest-out'
New-Item -ItemType Directory -Force $outDir | Out-Null

$dom = $null
for ($attempt = 1; $attempt -le 3; $attempt++) {
  $chromeArgs = @('--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', "--user-data-dir=$profileDir", '--virtual-time-budget=60000', '--dump-dom', $Url)
  # Redirect to a file: on Windows chrome.exe is a GUI program and its stdout does not reach a pipeline.
  $domFile = Join-Path $outDir 'dom.html'
  $p = Start-Process -FilePath $chrome -ArgumentList $chromeArgs -RedirectStandardOutput $domFile -RedirectStandardError (Join-Path $outDir 'chrome.log') -Wait -PassThru -NoNewWindow
  $dom = if (Test-Path $domFile) { [IO.File]::ReadAllText($domFile) } else { '' }
  if ($dom -match 'data-ready="1"') { break }
  Write-Host "Attempt $attempt did not finish loading; retrying"
}
Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue
if ($dom -notmatch 'data-ready="1"') {
  $m = [regex]::Match($dom, '<div id="mail">(.*?)</div>', 'Singleline')
  throw ('Digest page did not render: ' + $m.Groups[1].Value)
}

function Get-Part([string]$pattern) {
  $m = [regex]::Match($dom, $pattern, 'Singleline')
  if (-not $m.Success) { throw "Digest part missing: $pattern" }
  return $m.Groups[1].Value
}
$subject = [Net.WebUtility]::HtmlDecode((Get-Part '<pre id="subject"[^>]*>(.*?)</pre>'))
$html = Get-Part '<div id="mail">(.*)</div>\s*<pre id="text"'
$text = [Net.WebUtility]::HtmlDecode((Get-Part '<pre id="text"[^>]*>(.*?)</pre>'))

$utf8 = New-Object Text.UTF8Encoding $false
[IO.File]::WriteAllText((Join-Path $outDir 'digest.html'), $html, $utf8)
[IO.File]::WriteAllText((Join-Path $outDir 'digest.txt'), $text, $utf8)
Write-Host "Subject: $subject"
Write-Host $text

$smtpUrl = $env:SMTP_URL; $user = $env:SMTP_USER; $pass = $env:SMTP_PASS
$to = @(($env:DIGEST_TO -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$from = if ($env:DIGEST_FROM) { $env:DIGEST_FROM } else { $user }
if ($DryRun -or -not $smtpUrl -or -not $user -or -not $pass -or -not $to.Count) {
  Write-Host 'Not sending: dry run, or SMTP_URL / SMTP_USER / SMTP_PASS / DIGEST_TO not set.'
  exit 0
}

function B64([string]$s) { [Convert]::ToBase64String($utf8.GetBytes($s)) }
function Wrap([string]$s) { ($s -split '(.{76})' | Where-Object { $_ }) -join "`r`n" }
$boundary = 'abud-' + [Guid]::NewGuid().ToString('N')
$lines = @(
  "From: ABUD Portfolio <$from>",
  ('To: ' + ($to -join ', ')),
  ('Subject: =?UTF-8?B?' + (B64 $subject) + '?='),
  ('Date: ' + [DateTime]::UtcNow.ToString('r')),
  'MIME-Version: 1.0',
  "Content-Type: multipart/alternative; boundary=`"$boundary`"",
  '',
  "--$boundary",
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: base64',
  '',
  (Wrap (B64 $text)),
  "--$boundary",
  'Content-Type: text/html; charset=UTF-8',
  'Content-Transfer-Encoding: base64',
  '',
  (Wrap (B64 "<!doctype html><html><body>$html</body></html>")),
  "--$boundary--",
  ''
)
$eml = Join-Path $outDir 'digest.eml'
[IO.File]::WriteAllText($eml, ($lines -join "`r`n"), $utf8)

$curlArgs = @('--silent', '--show-error', '--fail', '--ssl-reqd', '--url', $smtpUrl, '--user', "${user}:${pass}", '--mail-from', $from)
foreach ($r in $to) { $curlArgs += @('--mail-rcpt', $r) }
$curlArgs += @('--upload-file', $eml)
$curl = (Get-Command curl -CommandType Application | Select-Object -First 1).Source
& $curl @curlArgs
if ($LASTEXITCODE -ne 0) { throw "curl could not send the digest (exit $LASTEXITCODE)" }
Write-Host ('Sent to ' + $to.Count + ' recipient(s).')
