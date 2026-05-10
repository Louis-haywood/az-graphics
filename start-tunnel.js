const { spawn } = require('child_process');
const proc = spawn(
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    ['tunnel', '--url', 'http://localhost:3000'],
    { stdio: 'inherit' }
);
proc.on('exit', code => process.exit(code));
