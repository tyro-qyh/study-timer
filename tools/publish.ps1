# 学习计时 · 一键发布脚本
# 用法（在 D:\SOFTWARE\study-timer 下）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\publish.ps1 -Version 1.2.0
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\publish.ps1 -DryRun
#
# 做的事：
#   1. 把 app\ 和 tools\ 同步进 repo\
#   2. 和 GitHub 上的文件逐个比对（用 git blob sha），只提交真正变了的文件
#   3. 用一个 commit 提交所有改动（走 Git Data API，不再一个文件一条记录）
#   4. 生成 zip、建/更新 release、上传附件
#
# 需要：.secrets\gh-token.txt（scope: public_repo）

param(
  [string]$Version = '',
  [string]$Message = '',
  [switch]$DryRun,
  [switch]$NoRelease,
  [string]$TokenFile = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root    = Split-Path -Parent $PSScriptRoot
$repoDir = Join-Path $root 'repo'
$appDir  = Join-Path $root 'app'
$toolsDir = Join-Path $root 'tools'
$owner   = 'tyro-qyh'
$name    = 'study-timer'
$branch  = 'main'
$api     = 'https://api.github.com'

if (-not $TokenFile) {
  if ($env:STUDY_TIMER_TOKEN_FILE) { $TokenFile = $env:STUDY_TIMER_TOKEN_FILE }
  else { $TokenFile = Join-Path $root '.secrets\gh-token.txt' }
}
if (-not (Test-Path $TokenFile)) { throw "找不到令牌文件：$TokenFile" }
$token = (Get-Content $TokenFile -Raw).Trim()
if (-not $token) { throw '令牌文件是空的' }
$headers = @{ Authorization = "token $token"; 'User-Agent' = 'study-timer-publish'; Accept = 'application/vnd.github+json' }

function Invoke-GitHub {
  param(
    [string]$Uri,
    [string]$Method = 'Get',
    $Body = $null,
    [switch]$Raw
  )
  $p = @{ Uri = $Uri; Headers = $headers; Method = $Method }
  if ($Body -ne $null) {
    $json = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 8 -Compress))
    $p.Body = $json
    $p.ContentType = 'application/json'
  }
  if ($Raw) { $p.Headers = @{ Authorization = "token $token"; 'User-Agent' = 'study-timer-publish'; Accept = 'application/octet-stream' } }
  return Invoke-RestMethod @p
}

function Get-BlobSha {
  param([byte[]]$Bytes)
  $header = [Text.Encoding]::UTF8.GetBytes("blob $($Bytes.Length)`0")
  $sha1 = [Security.Cryptography.SHA1]::Create()
  $all = New-Object byte[] ($header.Length + $Bytes.Length)
  [Array]::Copy($header, 0, $all, 0, $header.Length)
  [Array]::Copy($Bytes, 0, $all, $header.Length, $Bytes.Length)
  $hash = $sha1.ComputeHash($all)
  return ($hash | ForEach-Object { $_.ToString('x2') }) -join ''
}

function Sync-Dir {
  param([string]$From, [string]$To)
  if (-not (Test-Path $To)) { New-Item -ItemType Directory -Force -Path $To | Out-Null }
  robocopy $From $To /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "同步失败：$From -> $To (robocopy $LASTEXITCODE)" }
}

function Get-LocalFiles {
  $files = @()
  Get-ChildItem $repoDir -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($repoDir.Length + 1).Replace('\', '/')
    if ($rel -like '.git/*') { return }
    $files += [pscustomobject]@{
      Path  = $rel
      Local = $_.FullName
      Bytes = [IO.File]::ReadAllBytes($_.FullName)
    }
  }
  return $files
}

# ---------- 0. 版本号 ----------
if ($Version) {
  $pkgPath = Join-Path $appDir 'package.json'
  $pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $pkg.version = $Version
  ($pkg | ConvertTo-Json -Depth 4) | Set-Content $pkgPath -Encoding UTF8

  $changelog = Join-Path $repoDir 'CHANGELOG.md'
  if (-not (Test-Path $changelog)) { throw 'repo\CHANGELOG.md 不存在，先写一条本次更新' }
  $text = Get-Content $changelog -Raw -Encoding UTF8
  if ($text -notmatch "##\s*v$([regex]::Escape($Version))\b") {
    throw "CHANGELOG.md 里没有 v$Version 段落，先补上再发布"
  }
}

# ---------- 1. 同步 ----------
Sync-Dir $appDir (Join-Path $repoDir 'app')
Sync-Dir $toolsDir (Join-Path $repoDir 'tools')

# repo 里不该出现的东西
foreach ($junk in @('data', 'runtime', '.secrets', '_build')) {
  $p = Join-Path $repoDir $junk
  if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}

# ---------- 2. 比对 ----------
$ref = Invoke-GitHub "$api/repos/$owner/$name/git/ref/heads/$branch"
$headSha = $ref.object.sha
$commit = Invoke-GitHub "$api/repos/$owner/$name/git/commits/$headSha"
$treeSha = $commit.tree.sha
$tree = Invoke-GitHub "$api/repos/$owner/$name/git/trees/$treeSha`?recursive=1"
$remote = @{}
foreach ($e in $tree.tree) { if ($e.type -eq 'blob') { $remote[$e.path] = $e.sha } }

$local = Get-LocalFiles
$changed = @()
foreach ($f in $local) {
  $sha = Get-BlobSha $f.Bytes
  $f | Add-Member -NotePropertyName Sha -NotePropertyValue $sha -Force
  if (-not $remote.ContainsKey($f.Path) -or $remote[$f.Path] -ne $sha) { $changed += $f }
}
$deleted = @($remote.Keys | Where-Object { $local.Path -notcontains $_ })

Write-Host ("本地 {0} 个文件，远程 {1} 个；变更 {2} 个" -f $local.Count, $remote.Count, $changed.Count) -ForegroundColor Cyan
$changed | ForEach-Object { Write-Host ("  ~ {0}" -f $_.Path) }
if ($deleted.Count) { Write-Host ("  远程多出（不会自动删除）：{0}" -f ($deleted -join ', ')) -ForegroundColor Yellow }

if ($DryRun) { Write-Host 'DryRun：没有推送。' -ForegroundColor Yellow; return }
if (-not $changed.Count -and -not $Version) { Write-Host '没有变化，结束。' -ForegroundColor Green; return }

# ---------- 3. 一个 commit ----------
$entries = @()
foreach ($f in $changed) {
  $b64 = [Convert]::ToBase64String($f.Bytes)
  $blob = Invoke-GitHub "$api/repos/$owner/$name/git/blobs" -Method Post -Body @{ content = $b64; encoding = 'base64' }
  $entries += @{ path = $f.Path; mode = '100644'; type = 'blob'; sha = $blob.sha }
}

$commitMessage = 'chore: sync'; if ($Version) { $commitMessage = "v$Version" }; if ($Message) { $commitMessage = $Message }
$newCommit = Invoke-GitHub "$api/repos/$owner/$name/git/commits" -Method Post -Body @{
  message = $commitMessage
  tree    = (Invoke-GitHub "$api/repos/$owner/$name/git/trees" -Method Post -Body @{ base_tree = $treeSha; tree = $entries }).sha
  parents = @($headSha)
}
Invoke-GitHub "$api/repos/$owner/$name/git/refs/heads/$branch" -Method Patch -Body @{ sha = $newCommit.sha } | Out-Null
Write-Host ("提交完成：{0} 个文件 -> {1}" -f $entries.Count, $newCommit.sha.Substring(0, 7)) -ForegroundColor Green

if ($NoRelease -or -not $Version) {
  Write-Host '未指定版本号 / -NoRelease，跳过 release。' -ForegroundColor Yellow
  return
}

# ---------- 4. zip + release ----------
$build = Join-Path $root '_build'
$outDir = Join-Path $root '_build-out'
if (Test-Path $build) { Remove-Item $build -Recurse -Force -ErrorAction SilentlyContinue`nRemove-Item $outDir -Recurse -Force -ErrorAction SilentlyContinue }
if (Test-Path $outDir) { Remove-Item $outDir -Recurse -Force }
$stage = Join-Path $build "study-timer"
New-Item -ItemType Directory -Force -Path $stage | Out-Null
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Copy-Item (Join-Path $repoDir '*') $stage -Recurse -Force
Copy-Item (Join-Path $repoDir '.gitignore') $stage -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem
# zip 必须放在被压缩目录之外，否则会把自身也打进去（并锁住文件）
$zip = Join-Path $outDir "study-timer-$Version.zip"
[IO.Compression.ZipFile]::CreateFromDirectory($build, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)

$tag = "v$Version"
$body = ''
$text = Get-Content (Join-Path $repoDir 'CHANGELOG.md') -Raw -Encoding UTF8
$m = [regex]::Match($text, "##\s*v$([regex]::Escape($Version))[^\n]*\n(.*?)(?=\n##\s|$)", 'Singleline')
if ($m.Success) { $body = $m.Groups[1].Value.Trim() }

$existing = $null
try { $existing = Invoke-GitHub "$api/repos/$owner/$name/releases/tags/$tag" } catch { }

if ($existing) {
  Write-Host "release $tag 已存在，更新说明并替换附件" -ForegroundColor Yellow
  Invoke-GitHub "$api/repos/$owner/$name/releases/$($existing.id)" -Method Patch -Body @{ body = $body; name = "$tag - 学习计时 Study Timer" } | Out-Null
  foreach ($a in $existing.assets) {
    Invoke-GitHub "$api/repos/$owner/$name/releases/assets/$($a.id)" -Method Delete | Out-Null
  }
  $rel = $existing
} else {
  $rel = Invoke-GitHub "$api/repos/$owner/$name/releases" -Method Post -Body @{
    tag_name         = $tag
    target_commitish = $branch
    name             = "$tag - 学习计时 Study Timer"
    body             = $body
    draft            = $false
    prerelease       = $false
  }
}

$assetName = "study-timer-$Version.zip"
$upUrl = "https://uploads.github.com/repos/$owner/$name/releases/$($rel.id)/assets?name=$assetName"
$upHeaders = @{ Authorization = "token $token"; 'User-Agent' = 'study-timer-publish' }
$asset = Invoke-RestMethod -Uri $upUrl -Headers $upHeaders -Method Post -InFile $zip -ContentType 'application/zip'
Write-Host ("release {0} 附件 {1}（{2} KB）" -f $tag, $asset.name, [math]::Round($asset.size / 1KB)) -ForegroundColor Green
Write-Host ("{0}/releases/tag/{1}" -f "https://github.com/$owner/$name", $tag) -ForegroundColor Green

Remove-Item $build -Recurse -Force -ErrorAction SilentlyContinue`nRemove-Item $outDir -Recurse -Force -ErrorAction SilentlyContinue