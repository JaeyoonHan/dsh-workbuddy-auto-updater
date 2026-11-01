# 同步插件到 DSH 实际加载的位置
#
# DSH 的 profile 用 `file:` 依赖 + `nodeLinker: hoisted`
# （见 ~/.dsh/profiles/desktop/pnpm-workspace.yaml），所以 node_modules 里放的是
# 实体副本，不是符号链接。DSH 运行时加载的是那份副本。
#
# 结果：只改 ~/.dsh/plugins/dsh-workbuddy-auto-updater 里的源码，重启后不会生效，
# 必须把文件同步到 ~/.dsh/profiles/desktop/node_modules/dsh-workbuddy-auto-updater。
#
# 用法（请先完全退出 DSH，否则 Windows 会锁住正在运行的文件）：
#
#     powershell -ExecutionPolicy Bypass -File scripts/sync-to-profile.ps1

param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$source = Join-Path $env:USERPROFILE '.dsh\plugins\dsh-workbuddy-auto-updater'
$target = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\dsh-workbuddy-auto-updater'

Write-Host "源  : $source"
Write-Host "目标: $target"

if (-not (Test-Path $source)) { throw "找不到源目录: $source" }
if (-not (Test-Path $target)) {
    Write-Host '目标目录不存在，创建中…'
    New-Item -ItemType Directory -Path $target -Force | Out-Null
}

# 运行中的 DSH 会锁住这些文件，先确认是否在运行。
$running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($running -and -not $Force) {
    Write-Host ''
    Write-Host "检测到 DSH 正在运行（$($running.Count) 个进程）。" -ForegroundColor Yellow
    Write-Host '请完全退出 DSH 后重试；或加 -Force 尝试覆盖（可能因文件占用而失败）。' -ForegroundColor Yellow
    exit 1
}

# 只同步会被加载的内容；state.json / logs 是运行期数据，留在原处不动。
foreach ($dir in @('lib', 'locale', 'test')) {
    $from = Join-Path $source $dir
    $to = Join-Path $target $dir
    if (-not (Test-Path $from)) { continue }
    if (-not (Test-Path $to)) { New-Item -ItemType Directory -Path $to -Force | Out-Null }
    Copy-Item (Join-Path $from '*') -Destination $to -Recurse -Force
    Write-Host "  已同步 $dir/"
}

foreach ($file in @('package.json', 'README.md', 'cordis.patch.yml', 'LICENSE', '.gitignore')) {
    $from = Join-Path $source $file
    if (-not (Test-Path $from)) { continue }
    Copy-Item $from -Destination (Join-Path $target $file) -Force
    Write-Host "  已同步 $file"
}

# 逐文件校验，任何不一致都当作失败。
Write-Host ''
Write-Host '校验：'
$mismatch = 0
foreach ($file in @('lib\index.js', 'lib\client.js', 'lib\guard.js', 'lib\cli.js', 'package.json', 'cordis.patch.yml')) {
    $from = Join-Path $source $file
    $to = Join-Path $target $file
    if (-not (Test-Path $from)) { continue }
    if (-not (Test-Path $to)) {
        Write-Host "  MISSING $file" -ForegroundColor Red
        $mismatch++
        continue
    }
    $a = (Get-FileHash $from -Algorithm SHA256).Hash
    $b = (Get-FileHash $to -Algorithm SHA256).Hash
    if ($a -eq $b) {
        Write-Host "  OK      $file" -ForegroundColor Green
    } else {
        Write-Host "  DIFF    $file" -ForegroundColor Red
        $mismatch++
    }
}

Write-Host ''
if ($mismatch -gt 0) {
    Write-Host "同步未完成：$mismatch 个文件不一致，请确认 DSH 已完全退出。" -ForegroundColor Red
    exit 1
}
Write-Host '同步完成，重新打开 DSH 即可生效。' -ForegroundColor Green
