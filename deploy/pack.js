// 用 Node.js 打包部署文件，避免 PowerShell 中文路径编码问题
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const src = 'd:\\新建文件夹\\识别';
const temp = path.join(src, 'deploy', 'temp_pack');
const dst = path.join(src, 'deploy', 'ai-fde-deploy.zip');

// 清理
if (fs.existsSync(dst)) fs.unlinkSync(dst);
if (fs.existsSync(temp)) fs.rmSync(temp, { recursive: true, force: true });
fs.mkdirSync(temp, { recursive: true });

// 需要打包的文件/目录
const items = [
  'dist', 'ai-fde-minimal', 'paddle_ocr_service',
  'package.json', 'package-lock.json', 'config.json',
  '.env.production', 'ecosystem.config.cjs'
];

function copyRecursive(s, d) {
  if (fs.statSync(s).isDirectory()) {
    fs.mkdirSync(d, { recursive: true });
    for (const item of fs.readdirSync(s)) {
      copyRecursive(path.join(s, item), path.join(d, item));
    }
  } else {
    fs.copyFileSync(s, d);
  }
}

let fileCount = 0;
for (const item of items) {
  const s = path.join(src, item);
  const d = path.join(temp, item);
  if (fs.existsSync(s)) {
    copyRecursive(s, d);
    fileCount++;
    console.log(`Copied: ${item}`);
  } else {
    console.log(`Skip (not found): ${item}`);
  }
}

// 使用 PowerShell Compress-Archive 打包（通过参数传递路径避免编码问题）
console.log('Compressing...');
try {
  execSync(`powershell -Command "Compress-Archive -Path '${temp}\\*' -DestinationPath '${dst}' -CompressionLevel Optimal"`, { stdio: 'inherit' });
  const size = fs.statSync(dst).size / 1024 / 1024;
  console.log(`Package created: ${dst} (${size.toFixed(2)} MB)`);
} catch (e) {
  console.error('Compress failed:', e.message);
  process.exit(1);
}

// 清理临时目录
fs.rmSync(temp, { recursive: true, force: true });
console.log('Done.');
