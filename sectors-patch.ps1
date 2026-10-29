# Menambal src\index.ts (backend) dan functions\api\[[path]].js (frontend) untuk rute /api/market/sectors
# Jalankan dari folder backend: powershell -ExecutionPolicy Bypass -File sectors-patch.ps1
$ErrorActionPreference = "Stop"
$be = "E:\0\MAB Project\MAB-Terminal\mab-terminal-backend\src\index.ts"
$fe = "E:\0\MAB Project\MAB-Terminal\mab-terminal\functions\api\[[path]].js"
$enc = New-Object System.Text.UTF8Encoding($false)

function Patch($path, $anchor, $insert, $before) {
  $t = [IO.File]::ReadAllText($path, $enc)
  if ($t.Contains("/api/market/sectors")) { Write-Host "SKIP (sudah ada): $path"; return }
  $n = ([regex]::Matches($t, [regex]::Escape($anchor))).Count
  if ($n -ne 1) { throw "Anchor harus cocok 1 kali, ditemukan $n di $path" }
  Copy-Item -LiteralPath $path -Destination (Join-Path $env:TEMP ((Split-Path $path -Leaf) + ".sectors.bak")) -Force
  if ($before) { $t = $t.Replace($anchor, $insert + $anchor) } else { $t = $t.Replace($anchor, $anchor + $insert) }
  [IO.File]::WriteAllText($path, $t, $enc)
  Write-Host "OK: $path"
}

$route = @'
    // Rotasi sektor (ETF sektor AS, negara/obligasi, sektor IDX) dari TradingView scanner. Cache memori 30 dtk, tanpa KV
    if (url.pathname === "/api/market/sectors") {
      if (!authorized) return unauthorized();
      try {
        const { loadSectors } = await import("./feed/sectors");
        return Response.json(await loadSectors(env));
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 502 });
      }
    }

'@
Patch $be '    // Uji terjemahan Workers AI (diagnosa' $route $true
Patch $fe '  "/api/market/fxflow": [],' "`n  `"/api/market/sectors`": []," $false
