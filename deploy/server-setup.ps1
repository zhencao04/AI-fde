$ErrorActionPreference = "Continue"
$projectDir = "C:\wwwroot\ai-fde-observer"
$nodeDir = "C:\nodejs"
$nodeVersion = "v20.15.0"
$nodeZip = "C:\nodejs.zip"

Write-Host "===== Step 1: Install Node.js ====="

if (Test-Path "$nodeDir\node.exe") {
    Write-Host "Node.js already exists at $nodeDir"
} else {
    Write-Host "Downloading Node.js $nodeVersion ..."
    $nodeUrl = "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-x64.zip"
    Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip -UseBasicParsing
    
    if (Test-Path $nodeZip) {
        Write-Host "Extracting Node.js ..."
        Expand-Archive -Path $nodeZip -DestinationPath "C:\nodejs-temp" -Force
        $inner = Get-ChildItem "C:\nodejs-temp" -Directory | Select-Object -First 1
        if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
        Move-Item $inner.FullName $nodeDir -Force
        Remove-Item "C:\nodejs-temp" -Recurse -Force
        Remove-Item $nodeZip -Force
        Write-Host "Node.js extracted to $nodeDir"
    } else {
        Write-Host "ERROR: Download failed"
        exit 1
    }
}

$currentPath = [Environment]::GetEnvironmentVariable("Path", "Machine")
if ($currentPath -notlike "*$nodeDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$currentPath;$nodeDir", "Machine")
    Write-Host "Added $nodeDir to system PATH"
}
$env:Path = "$env:Path;$nodeDir"

$nodeExe = "$nodeDir\node.exe"
$npmExe = "$nodeDir\npm.cmd"
Write-Host "Node version: $(. $nodeExe -v)"
Write-Host "npm version: $(. $npmExe -v)"

Write-Host "===== Step 2: Extract Project ====="
$zipFile = "$projectDir\ai-fde-deploy.zip"
if (Test-Path $zipFile) {
    Write-Host "Extracting project ..."
    Expand-Archive -Path $zipFile -DestinationPath $projectDir -Force
    Remove-Item $zipFile -Force
    Write-Host "Project extracted"
} else {
    Write-Host "Zip not found, skip"
}

Write-Host "Project files:"
Get-ChildItem $projectDir | ForEach-Object { Write-Host "  $($_.Name)" }

Write-Host "===== Step 3: Install PM2 ====="
. $npmExe install -g pm2 2>&1 | ForEach-Object { Write-Host $_ }
Write-Host "PM2 installed"

Write-Host "===== Step 4: Configure npm mirror ====="
. $npmExe config set registry https://registry.npmmirror.com

Write-Host "===== Step 5: Install Dependencies ====="
Push-Location $projectDir
. $npmExe install --production 2>&1 | ForEach-Object { Write-Host $_ }
Pop-Location
Write-Host "Dependencies installed"

Write-Host "===== Step 6: Configure .env ====="
$envFile = "$projectDir\.env"
if (-not (Test-Path $envFile)) {
    Copy-Item "$projectDir\.env.production" $envFile -Force
    Write-Host ".env created from .env.production"
} else {
    Write-Host ".env already exists"
}

Write-Host "===== Step 7: Start PM2 ====="
Push-Location $projectDir
. $nodeExe "$nodeDir\node_modules\pm2\bin\pm2" start ecosystem.config.cjs --only observer-api 2>&1 | ForEach-Object { Write-Host $_ }
. $nodeExe "$nodeDir\node_modules\pm2\bin\pm2" save 2>&1 | Out-Null
Pop-Location

Write-Host "===== Step 8: Verify ====="
Start-Sleep 3
. $nodeExe -e "const http=require('http');http.get('http://127.0.0.1:3000/api/system/status',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{console.log('API Status:',r.statusCode);console.log('Response:',d.substring(0,200))})}).on('error',e=>console.log('Error:',e.message))"

Write-Host ""
Write-Host "===== DONE ====="
Write-Host "Project: $projectDir"
Write-Host "Node: $nodeDir"
Write-Host "API: http://127.0.0.1:3000"
Write-Host "Remember: Edit .env to set LLM_API_KEY"
