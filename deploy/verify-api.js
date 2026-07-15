const http = require('http');
http.get('http://127.0.0.1:3000/api/system/status', r => {
  let d = '';
  r.on('data', c => d += c);
  r.on('end', () => {
    console.log('Status:', r.statusCode);
    console.log('Body:', d.substring(0, 300));
    process.exit(0);
  });
}).on('error', e => {
  console.log('Error:', e.message);
  process.exit(1);
});
