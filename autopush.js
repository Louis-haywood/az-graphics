const { execSync } = require('child_process');
const path = require('path');

const repoPath = path.join(__dirname);
const interval = 10000; // 10 seconds

console.log(`Auto-push watching ${repoPath} every ${interval / 1000}s...`);

function check() {
    try {
        const status = execSync('git status --porcelain', { cwd: repoPath }).toString().trim();
        if (status) {
            console.log(`[${new Date().toLocaleTimeString()}] Changes detected — pushing...`);
            execSync('git add -A', { cwd: repoPath });
            execSync(`git commit -m "Auto: update ${new Date().toISOString()}"`, { cwd: repoPath });
            execSync('git push', { cwd: repoPath });
            console.log(`[${new Date().toLocaleTimeString()}] Pushed successfully.`);
        }
    } catch (err) {
        console.error(`[${new Date().toLocaleTimeString()}] Error:`, err.message);
    }
}

check();
setInterval(check, interval);
