# npm 发布准备脚本
#
# 用途：在你拿到 npm token 后，一条命令完成发布 + 验证。
#
# 前置：先创建 token（二选一）
#   A. 网页：https://www.npmjs.com/settings/<你的用户名>/tokens  → Generate New Token → Automation
#   B. 命令行（会打开浏览器）：npm login
#
# 用法：
#   $env:NPM_TOKEN = "npm_xxxxxxxx"
#   powershell -ExecutionPolicy Bypass -File scripts/publish-npm.ps1
#
# 或者先写入用户级 .npmrc 再运行本脚本（脚本会检测到已登录）。

param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$pkgDir = Join-Path $env:USERPROFILE '.dsh\plugins\dsh-workbuddy-auto-updater'
$npm = 'C:\Program Files\nodejs\npm.cmd'

Write-Host "包目录: $pkgDir"
if (-not (Test-Path $pkgDir)) { throw "找不到包目录" }
Set-Location $pkgDir

# --- 1. 令牌准备 ---------------------------------------------------------
$token = $env:NPM_TOKEN
$npmrc = Join-Path $env:USERPROFILE '.npmrc'

if ($token) {
    Write-Host '检测到 NPM_TOKEN，写入临时 .npmrc…'
    $existing = if (Test-Path $npmrc) { Get-Content $npmrc -Raw } else { '' }
    # 只移除 registry 的 auth 行，保留其它配置
    $cleaned = ($existing -split "`n" | Where-Object { $_ -notmatch '^//registry\.npmjs\.org/:_authToken=' }) -join "`n"
    $line = "//registry.npmjs.org/:_authToken=$token"
    Set-Content -Path $npmrc -Value (($cleaned.TrimEnd() + "`n" + $line).TrimStart()) -NoNewline -Encoding utf8
    Write-Host '  已写入。发布完成后本脚本会还原。'
    $createdAuth = $true
} else {
    $createdAuth = $false
}

try {
    # --- 2. 校验登录 -----------------------------------------------------
    Write-Host ''
    Write-Host '检查登录状态…'
    $who = & $npm whoami 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host '未登录。请先执行以下任一步骤：' -ForegroundColor Yellow
        Write-Host '  npm login'
        Write-Host '  或设置环境变量 NPM_TOKEN 后重试'
        exit 1
    }
    Write-Host "  已登录为: $who" -ForegroundColor Green

    # --- 3. 发布前自检 ---------------------------------------------------
    Write-Host ''
    Write-Host '发布前自检：'
    $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
    Write-Host "  版本: $version"

    $check = & $npm pack --dry-run 2>&1 | Out-String
    if ($check -match 'state\.json' -or $check -match 'logs/') {
        Write-Host '  警告：包里混入了运行期文件！' -ForegroundColor Red
        exit 1
    }
    Write-Host '  包内容干净（无 state.json / logs）' -ForegroundColor Green

    foreach ($f in @('lib\index.js', 'lib\client.js', 'lib\guard.js', 'lib\cli.js')) {
        if (-not (Test-Path $f)) { Write-Host "  缺少 $f" -ForegroundColor Red; exit 1 }
    }
    Write-Host '  四个 lib 文件齐全' -ForegroundColor Green

    # --- 4. 发布 ---------------------------------------------------------
    Write-Host ''
    if ($DryRun) {
        Write-Host 'DryRun：跳过实际发布。' -ForegroundColor Cyan
        & $npm publish --dry-run 2>&1 | Select-Object -Last 15
        exit 0
    }

    Write-Host '开始发布…'
    & $npm publish --access public 2>&1 | Select-Object -Last 20
    if ($LASTEXITCODE -ne 0) {
        Write-Host '发布失败，见上方输出。' -ForegroundColor Red
        exit 1
    }

    # --- 5. 验证 ---------------------------------------------------------
    Write-Host ''
    Write-Host '等待 registry 同步…'
    Start-Sleep -Seconds 5
    $encoded = 'dsh-workbuddy-auto-updater'
    $nodeScript = @"
(async () => {
  try {
    const r = await fetch('https://registry.npmjs.org/$encoded/latest', { signal: AbortSignal.timeout(20000) });
    if (r.status !== 200) { console.log('  尚未可见: HTTP ' + r.status); process.exit(1); }
    const j = await r.json();
    console.log('  已发布: ' + j.name + '@' + j.version);
  } catch (e) { console.log('  验证失败: ' + e.message); process.exit(1); }
})();
"@
    node -e $nodeScript

    Write-Host ''
    Write-Host "完成。安装方式：" -ForegroundColor Green
    Write-Host '  dsh plugin --profile desktop add dsh-workbuddy-auto-updater'
}
finally {
    # --- 6. 还原 .npmrc --------------------------------------------------
    if ($createdAuth) {
        Write-Host ''
        Write-Host '还原 .npmrc（移除 token）…'
        $final = Get-Content $npmrc -Raw
        $stripped = ($final -split "`n" | Where-Object { $_ -notmatch '^//registry\.npmjs\.org/:_authToken=' }) -join "`n"
        if ([string]::IsNullOrWhiteSpace($stripped)) {
            Remove-Item $npmrc -Force
            Write-Host '  已删除临时 .npmrc'
        } else {
            Set-Content -Path $npmrc -Value $stripped.TrimEnd() -NoNewline -Encoding utf8
            Write-Host '  已移除 token 行'
        }
    }
}
