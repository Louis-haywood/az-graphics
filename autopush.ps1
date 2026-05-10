$repoPath = "C:\Users\Administrator\Documents\az-graphics"
$checkInterval = 10  # seconds

Write-Host "Auto-push watching $repoPath every $checkInterval seconds..." -ForegroundColor Cyan

while ($true) {
    Set-Location $repoPath

    $status = git status --porcelain
    if ($status) {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Changes detected — pushing..." -ForegroundColor Yellow
        git add -A
        git commit -m "Auto: portfolio update $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
        git push
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Pushed." -ForegroundColor Green
    }

    Start-Sleep -Seconds $checkInterval
}
