#!/usr/bin/env node
/**
 * 一键部署脚本
 * 用法: node deploy/deploy.js
 *
 * 功能:
 *   1. 构建项目 (npm run build)
 *   2. 打包部署文件 (deploy/ai-fde-deploy.zip)
 *   3. 上传到服务器 (SFTP)
 *   4. 远程解压并重启服务 (SSH)
 *   5. 验证部署
 *
 * 前提:
 *   - 当前在 main 分支（或确认要部署的版本）
 *   - 服务器已配置好 (SSH 连接信息在下方)
 *   - 本地已安装 ssh2 (npm install ssh2 --no-save)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

// ===== 服务器配置 =====
const HOST = '152.136.227.164';
const PORT = 22;
const USER = 'Administrator';
const PASS = '.W-g{[q=}~^]N82w';
const REMOTE_DIR = 'C:/wwwroot/ai-fde-observer';
const SERVICE_NAME = 'ObserverApi';

// ===== 项目路径 =====
const PROJECT_DIR = path.resolve(__dirname, '..');
const DEPLOY_DIR = path.join(PROJECT_DIR, 'deploy');
const ZIP_FILE = path.join(DEPLOY_DIR, 'ai-fde-deploy.zip');

// ===== 需要打包的文件 =====
const INCLUDE = [
  'dist', 'ai-fde-minimal', 'paddle_ocr_service',
  'package.json', 'package-lock.json', 'config.json',
  '.env.production', 'ecosystem.config.cjs'
];

// ===== 步骤 =====
function step(name, fn) {
  console.log(`\n===== ${name} =====`);
  return fn();
}

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'inherit', cwd: PROJECT_DIR, ...opts });
}

// Step 1: 构建
function build() {
  console.log('Building project...');
  run('npm run build');
  console.log('Build complete.');
}

// Step 2: 打包
function pack() {
  const tempDir = path.join(DEPLOY_DIR, 'temp_pack');
  if (fs.existsSync(ZIP_FILE)) fs.unlinkSync(ZIP_FILE);
  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });

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

  let count = 0;
  for (const item of INCLUDE) {
    const s = path.join(PROJECT_DIR, item);
    const d = path.join(tempDir, item);
    if (fs.existsSync(s)) {
      copyRecursive(s, d);
      count++;
      console.log(`  Copied: ${item}`);
    } else {
      console.log(`  Skip (not found): ${item}`);
    }
  }

  console.log(`Compressing ${count} items...`);
  execSync(`powershell -Command "Compress-Archive -Path '${tempDir}\\*' -DestinationPath '${ZIP_FILE}' -CompressionLevel Optimal"`, { stdio: 'inherit' });
  fs.rmSync(tempDir, { recursive: true, force: true });

  const size = fs.statSync(ZIP_FILE).size / 1024 / 1024;
  console.log(`Package created: ${ZIP_FILE} (${size.toFixed(2)} MB)`);
}

// Step 3: 上传
function upload() {
  return new Promise((resolve, reject) => {
    console.log(`Uploading to ${HOST}:${REMOTE_DIR} ...`);
    const conn = new Client();
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) { reject(err); return; }
        const remotePath = `${REMOTE_DIR}/ai-fde-deploy.zip`;
        sftp.fastPut(ZIP_FILE, remotePath, (err) => {
          if (err) { reject(err); return; }
          console.log('Upload complete.');
          conn.end();
          resolve();
        });
      });
    }).on('error', reject).connect({
      host: HOST, port: PORT, username: USER, password: PASS,
      readyTimeout: 30000,
      algorithms: { serverHostKey: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-dss'] },
    });
  });
}

// Step 4: 远程解压并重启
function remoteDeploy() {
  return new Promise((resolve, reject) => {
    console.log('Remote extracting and restarting service...');
    const conn = new Client();
    const cmd = `powershell -Command "Expand-Archive -Path '${REMOTE_DIR}\\ai-fde-deploy.zip' -DestinationPath '${REMOTE_DIR}' -Force; Remove-Item '${REMOTE_DIR}\\ai-fde-deploy.zip' -Force; C:\\nssm\\nssm.exe restart ${SERVICE_NAME}"`;
    conn.on('ready', () => {
      conn.exec(cmd, (err, stream) => {
        if (err) { reject(err); return; }
        let out = '', err_ = '';
        stream.on('data', d => out += d.toString());
        stream.stderr.on('data', d => err_ += d.toString());
        stream.on('close', code => {
          if (out) console.log(out);
          if (err_) console.error(err_);
          conn.end();
          if (code === 0) { console.log('Service restarted.'); resolve(); }
          else { reject(new Error(`Remote command failed: exit ${code}`)); }
        });
      });
    }).on('error', reject).connect({
      host: HOST, port: PORT, username: USER, password: PASS,
      readyTimeout: 30000,
      algorithms: { serverHostKey: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-dss'] },
    });
  });
}

// Step 5: 验证
function verify() {
  return new Promise((resolve) => {
    console.log('Verifying deployment...');
    setTimeout(() => {
      const http = require('http');
      http.get(`http://${HOST}:3000/api/system/status`, r => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => {
          console.log(`API Status: ${r.statusCode}`);
          console.log(`Response: ${d.substring(0, 200)}`);
          if (r.statusCode === 200) {
            console.log('\n===== DEPLOYMENT SUCCESSFUL =====');
            console.log(`Access URL: http://${HOST}:3000/`);
          } else {
            console.log('\n===== DEPLOYMENT MAY HAVE ISSUES =====');
          }
          resolve();
        });
      }).on('error', e => {
        console.log(`Verify error: ${e.message}`);
        resolve();
      });
    }, 5000);
  });
}

// ===== 主流程 =====
async function main() {
  console.log('AI FDE Observer - One-Click Deploy');
  console.log(`Project: ${PROJECT_DIR}`);
  console.log(`Target:  ${HOST}:${REMOTE_DIR}`);

  // 检查当前分支
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: PROJECT_DIR }).toString().trim();
    console.log(`Branch:  ${branch}`);
    if (branch === 'dev') {
      console.log('\nWARNING: You are on dev branch. Usually you should deploy from main.');
      console.log('Press Ctrl+C to abort, or wait 3 seconds to continue...');
      await new Promise(r => setTimeout(r, 3000));
    }
  } catch {}

  try {
    step('1/5 Build', build);
    step('2/5 Pack', pack);
    await step('3/5 Upload', upload);
    await step('4/5 Remote Deploy', remoteDeploy);
    await step('5/5 Verify', verify);
  } catch (e) {
    console.error('\n===== DEPLOYMENT FAILED =====');
    console.error(e.message);
    process.exit(1);
  }
}

main();
