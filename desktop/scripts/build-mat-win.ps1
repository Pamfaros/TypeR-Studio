$ErrorActionPreference = "Stop"
Set-Location (Resolve-Path (Join-Path $PSScriptRoot ".."))
if (-not (Test-Path ".\mat\mat_worker.py")) { throw "Missing MAT worker" }
if (-not (Test-Path ".\mat\requirements-mat.txt")) { throw "Missing MAT requirements" }
if (-not (Test-Path ".\mat\MAT\legacy.py")) { throw "Missing MAT checkout; clone it into desktop/mat/MAT on the BUILD machine" }
# Bundle uv.exe once. End users do not need uv, Python, Git or npm installed.
$uvVersion = '0.12.23'
$uvExe = Join-Path (Get-Location) 'mat\uv.exe'
if (-not (Test-Path $uvExe)) {
    $url = "https://github.com/astral-sh/uv/releases/download/$uvVersion/uv-x86_64-pc-windows-msvc.zip"
    $zip = Join-Path $env:TEMP "typer-uv-$uvVersion.zip"
    $sum = "$zip.sha256"
    Write-Host "Downloading portable uv $uvVersion for embedding in EXE..."
    Invoke-WebRequest -Uri $url -OutFile $zip
    Invoke-WebRequest -Uri "$url.sha256" -OutFile $sum
    $expected = (Get-Content $sum -Raw).Trim().Split(' ')[0].ToLowerInvariant()
    $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expected -ne $actual) { throw 'uv archive checksum mismatch' }
    $extract = Join-Path $env:TEMP "typer-uv-$uvVersion-unpacked"
    New-Item -ItemType Directory -Force $extract | Out-Null
    Expand-Archive -Path $zip -DestinationPath $extract -Force
    $found = Get-ChildItem -Path $extract -Filter uv.exe -Recurse | Select-Object -First 1
    if (-not $found) { throw 'uv.exe not found in archive' }
    Copy-Item $found.FullName $uvExe -Force
}
& $uvExe --version
if ($LASTEXITCODE -ne 0) { throw 'uv.exe is not executable' }

npm run content
if ($LASTEXITCODE -ne 0) { throw "Content build failed" }
node .\scripts\prepare-mat-fork.js
if ($LASTEXITCODE -ne 0) { throw "Fork preparation failed" }
node --check .\src\mat-engine.js
if ($LASTEXITCODE -ne 0) { throw "MAT engine syntax error" }
node --check .\src\mat-installer.js
if ($LASTEXITCODE -ne 0) { throw "MAT installer syntax error" }
node --check .\src\content.js
if ($LASTEXITCODE -ne 0) { throw "Content patch syntax error" }
node --check .\src\main.js
if ($LASTEXITCODE -ne 0) { throw "Main process syntax error" }
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
npx electron-builder `
    --win nsis `
    --config .\electron-builder.mat.cjs `
    --publish never
if ($LASTEXITCODE -ne 0) { throw "Electron builder failed" }
Write-Host "Look for installer in desktop\dist-mat\TypeR-Studio-MAT-Setup-*.exe"

# Verify that the packaged application really contains its bootstrap tools.
$resourceDir = Join-Path (Get-Location) 'dist-mat\win-unpacked\resources\mat'
foreach ($asset in @('uv.exe', 'MAT\legacy.py', 'MAT\networks\mat.py', 'mat_worker.py', 'requirements-mat.txt')) {
    if (-not (Test-Path (Join-Path $resourceDir $asset))) {
        throw "Packaged Windows app missing MAT resource: $asset. Inspect extraResources configuration."
    }
}
Write-Host 'MAT portable resources verified in win-unpacked.'
