const fs = require('fs');
const path = require('path');

const backendPath = path.join(__dirname, 'src/server/index.ts');
const frontendScriptPath = path.join(__dirname, 'FRONTEND_SCRIPT_NEW.js');

let backendCode = fs.readFileSync(backendPath, 'utf-8');
const frontendScript = fs.readFileSync(frontendScriptPath, 'utf-8');

const startMarker = 'const FRONTEND_SCRIPT = `';

const startIdx = backendCode.indexOf(startMarker);

if (startIdx === -1) {
  console.error('找不到 FRONTEND_SCRIPT 常量');
  process.exit(1);
}

const before = backendCode.slice(0, startIdx);

const escapedFrontend = frontendScript.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const newBackendCode = before + 'const FRONTEND_SCRIPT = `' + escapedFrontend + '`;';

fs.writeFileSync(backendPath, newBackendCode, 'utf-8');

console.log('✅ FRONTEND_SCRIPT 已成功更新');
console.log('前端脚本行数:', frontendScript.split('\n').length);
console.log('后端文件总行数:', newBackendCode.split('\n').length);
