# PhoenixChat local server (Windows PowerShell 5.1+, no dependencies)
# Launch: powershell -ExecutionPolicy Bypass -File serve.ps1   (or use start-windows.bat)
param([int]$Port = 8000)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootSec = $root.TrimEnd('\') + '\'

$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
  '.txt'  = 'text/plain; charset=utf-8'
  '.md'   = 'text/plain; charset=utf-8'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() } catch {
  Write-Host "Cannot start on port ${Port}: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
Write-Host "PhoenixChat: http://localhost:$Port  (Ctrl+C to stop)" -ForegroundColor Green

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    try {
      $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
      if ($rel -eq '/') { $rel = '/index.html' }
      $file = Join-Path $root ($rel.TrimStart('/') -replace '/', '\')
      if ((Test-Path $file -PathType Leaf) -and ((Resolve-Path $file).Path.StartsWith($rootSec))) {
        $bytes = [IO.File]::ReadAllBytes($file)
        $ext = [IO.Path]::GetExtension($file).ToLower()
        if (-not $types.ContainsKey($ext)) { $ext = '.txt' }
        $ctx.Response.ContentType = $types[$ext]
        $ctx.Response.Headers['Cache-Control'] = 'no-cache'
        $ctx.Response.ContentLength64 = $bytes.Length
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      } else {
        $ctx.Response.StatusCode = 404
        $bytes = [Text.Encoding]::UTF8.GetBytes('404')
        $ctx.Response.ContentType = 'text/plain'
        $ctx.Response.ContentLength64 = $bytes.Length
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      }
    } catch {}
    finally { try { $ctx.Response.OutputStream.Close() } catch {} }
  }
} finally { $listener.Stop() }
