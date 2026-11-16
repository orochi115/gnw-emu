// Private POSIX watchdog. EOF on the owning UI's pipe means it has died.
const { execFileSync } = require('node:child_process');
let target, released = false, text = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  text += chunk;
  let end;
  while ((end = text.indexOf('\n')) >= 0) {
    const line = text.slice(0, end); text = text.slice(end + 1);
    if (line === 'release') { released = true; process.exit(0); }
    else target = JSON.parse(line);
  }
});
process.stdin.on('end', () => {
  if (!released && target) {
    try {
      const birth = execFileSync('/bin/ps', ['-p', String(target.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
      // A numeric PID alone is not proof of ownership after process reuse.
      if (birth === target.birth) process.kill(-target.pid, 'SIGKILL');
    } catch { /* Already exited. */ }
  }
  process.exit(0);
});
