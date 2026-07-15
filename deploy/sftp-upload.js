const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const HOST = '152.136.227.164';
const PORT = 22;
const USER = 'Administrator';
const PASS = '.W-g{[q=}~^]N82w';

const localPath = process.argv[2];
const remotePath = process.argv[3];

if (!localPath || !remotePath) {
  console.error('Usage: node sftp-upload.js <local-path> <remote-path>');
  process.exit(1);
}

const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) {
      console.error('SFTP error:', err.message);
      conn.end();
      process.exit(1);
    }

    const stat = fs.statSync(localPath);
    if (stat.isDirectory()) {
      uploadDir(sftp, localPath, remotePath, () => {
        console.log(`Directory uploaded: ${localPath} -> ${remotePath}`);
        conn.end();
      });
    } else {
      uploadFile(sftp, localPath, remotePath, () => {
        console.log(`File uploaded: ${localPath} -> ${remotePath}`);
        conn.end();
      });
    }
  });
}).on('error', (err) => {
  console.error('SSH error:', err.message);
  process.exit(1);
}).connect({
  host: HOST,
  port: PORT,
  username: USER,
  password: PASS,
  readyTimeout: 30000,
  algorithms: {
    serverHostKey: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-dss'],
  },
});

function uploadFile(sftp, localPath, remotePath, callback) {
  sftp.fastPut(localPath, remotePath, (err) => {
    if (err) {
      console.error(`Upload failed: ${localPath} -> ${remotePath}: ${err.message}`);
      process.exit(1);
    }
    callback();
  });
}

function uploadDir(sftp, localDir, remoteDir, callback) {
  sftp.mkdir(remoteDir, (err) => {
    // Ignore "already exists" error
    const items = fs.readdirSync(localDir);
    let pending = items.length;
    if (pending === 0) { callback(); return; }
    items.forEach(item => {
      const localItem = path.join(localDir, item);
      const remoteItem = remoteDir + '/' + item;
      const stat = fs.statSync(localItem);
      if (stat.isDirectory()) {
        uploadDir(sftp, localItem, remoteItem, () => {
          if (--pending === 0) callback();
        });
      } else {
        uploadFile(sftp, localItem, remoteItem, () => {
          if (--pending === 0) callback();
        });
      }
    });
  });
}
