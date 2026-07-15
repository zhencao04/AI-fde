const { Client } = require('ssh2');

const HOST = '152.136.227.164';
const PORT = 22;
const USER = 'Administrator';
const PASS = '.W-g{[q=}~^]N82w';

const cmd = process.argv.slice(2).join(' ');
if (!cmd) {
  console.error('Usage: node ssh-exec.js <command>');
  process.exit(1);
}

const conn = new Client();
conn.on('ready', () => {
  conn.exec(cmd, (err, stream) => {
    if (err) {
      console.error('Exec error:', err.message);
      conn.end();
      process.exit(1);
    }
    let stdout = '', stderr = '';
    stream.on('data', (d) => stdout += d.toString());
    stream.stderr.on('data', (d) => stderr += d.toString());
    stream.on('close', (code) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      console.log(`\n[exit code: ${code}]`);
      conn.end();
      process.exit(code);
    });
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
