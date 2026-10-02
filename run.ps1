<#
.SYNOPSIS
  Compila e roda o pauta.

.EXAMPLE
  .\run.ps1              # compila tudo e abre http://127.0.0.1:7272
  .\run.ps1 -Dev         # servidor + Vite com hot reload em http://localhost:5179
  .\run.ps1 -Test        # testes do Go, do nucleo CRDT (vitest) e checagem de tipos
  .\run.ps1 -Port 8080 -NoBrowser
#>
param(
    [switch]$Dev,
    [switch]$Test,
    [switch]$NoBrowser,
    [int]$Port = 7272
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Green }
function Need($cmd, $hint) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Host "Faltando: $cmd. $hint" -ForegroundColor Red
        exit 1
    }
}

Need go   'Instale Go 1.26+ em https://go.dev/dl/'
Need node 'Instale Node 22+ em https://nodejs.org/'
Need npm  'O npm vem junto com o Node.'

Push-Location ui
try {
    if (-not (Test-Path node_modules)) {
        Step 'Instalando dependências do frontend'
        npm install --no-audit --no-fund
        if ($LASTEXITCODE) { throw 'npm install falhou' }
    }
} finally { Pop-Location }

if ($Test) {
    Step 'Testes do servidor (Go)'
    go vet ./cmd/... ./internal/...
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    go test ./cmd/... ./internal/...
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    Step 'Testes do núcleo CRDT (vitest)'
    Push-Location ui
    npm test
    $code = $LASTEXITCODE
    if (-not $code) {
        Step 'Checagem de tipos'
        npm run typecheck
        $code = $LASTEXITCODE
    }
    Pop-Location
    exit $code
}

if ($Dev) {
    Step "Backend em http://127.0.0.1:$Port (janela separada)"
    $backend = Start-Process -PassThru -FilePath go -ArgumentList @('run', './cmd/pauta', '-addr', "127.0.0.1:$Port") -WorkingDirectory $root
    try {
        Step 'Frontend com hot reload em http://localhost:5179'
        if (-not $NoBrowser) { Start-Process 'http://localhost:5179' }
        Push-Location ui
        npm run dev
    } finally {
        Pop-Location
        # go run spawns a child process: kill the whole tree.
        if ($backend -and -not $backend.HasExited) { taskkill /PID $backend.Id /T /F | Out-Null }
    }
    exit 0
}

Step 'Compilando o frontend'
Push-Location ui
try {
    npm run build
    if ($LASTEXITCODE) { throw 'build do frontend falhou' }
} finally { Pop-Location }

Step 'Compilando o binário (frontend embutido)'
New-Item -ItemType Directory -Force bin | Out-Null
go build -trimpath -ldflags '-s -w' -o bin/pauta.exe ./cmd/pauta
if ($LASTEXITCODE) { throw 'go build falhou' }

$url = "http://127.0.0.1:$Port"
Step "pauta rodando em $url  (Ctrl+C para parar)"
if (-not $NoBrowser) {
    Start-Job -ScriptBlock {
        param($u)
        for ($i = 0; $i -lt 40; $i++) {
            try { Invoke-WebRequest "$u/api/health" -UseBasicParsing -TimeoutSec 1 | Out-Null; Start-Process $u; return } catch { Start-Sleep -Milliseconds 250 }
        }
    } -ArgumentList $url | Out-Null
}
& "$root\bin\pauta.exe" -addr "127.0.0.1:$Port" -data "$root\data\pauta.db"
