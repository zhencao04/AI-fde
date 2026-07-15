$src = 'd:\新建文件夹\识别'
$dst = 'd:\新建文件夹\识别\deploy\ai-fde-deploy.zip'
$temp = 'd:\新建文件夹\识别\deploy\temp_pack'

if (Test-Path $dst) { Remove-Item $dst -Force }
if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }
New-Item -ItemType Directory -Path $temp -Force | Out-Null

# 复制需要部署的文件
Copy-Item "$src\dist" "$temp\dist" -Recurse
Copy-Item "$src\ai-fde-minimal" "$temp\ai-fde-minimal" -Recurse
Copy-Item "$src\paddle_ocr_service" "$temp\paddle_ocr_service" -Recurse
Copy-Item "$src\package.json" "$temp\package.json"
Copy-Item "$src\package-lock.json" "$temp\package-lock.json"
Copy-Item "$src\config.json" "$temp\config.json"
Copy-Item "$src\.env.production" "$temp\.env.production"
Copy-Item "$src\ecosystem.config.cjs" "$temp\ecosystem.config.cjs"

# 打包
Compress-Archive -Path "$temp\*" -DestinationPath $dst -CompressionLevel Optimal
Remove-Item $temp -Recurse -Force

$size = (Get-Item $dst).Length / 1MB
Write-Host "Package created: $dst ($([math]::Round($size, 2)) MB)"
