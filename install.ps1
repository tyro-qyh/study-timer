# 学习计时 · Windows 安装脚本
# 用法：右键「使用 PowerShell 运行」，或
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
#
# 首次运行会下载 Electron 运行时（约 137 MB 压缩包，解压后约 350 MB），
# 之后创建桌面快捷方式。不写注册表、不开机自启、不做系统级改动。

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$App = Join-Path $Root 'app'
$Runtime = Join-Path $Root 'runtime'
$ElectronVersion = '43.3.0'

if (-not (Test-Path $App)) {
  throw "没找到 app 目录。请把 ZIP 完整解压，再在解压后的目录里运行本脚本。"
}

$exe = Join-Path $Runtime 'electron.exe'
if (-not (Test-Path $exe)) {
  Write-Host "首次安装：下载 Electron $ElectronVersion ..."
  $zip = Join-Path $env:TEMP "electron-v$ElectronVersion-win32-x64.zip"
  $urls = @(
    "https://npmmirror.com/mirrors/electron/$ElectronVersion/electron-v$ElectronVersion-win32-x64.zip",
    "https://github.com/electron/electron/releases/download/v$ElectronVersion/electron-v$ElectronVersion-win32-x64.zip"
  )
  $done = $false
  foreach ($u in $urls) {
    try {
      Write-Host "  从 $u"
      Invoke-WebRequest -Uri $u -OutFile $zip -UseBasicParsing
      $done = $true
      break
    } catch {
      Write-Host "  失败，换下一个源"
    }
  }
  if (-not $done) { throw "Electron 下载失败，请检查网络后重试。" }

  Write-Host "  解压到 $Runtime ..."
  New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $Runtime)
  } catch {
    Expand-Archive -Path $zip -DestinationPath $Runtime -Force
  }
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
}

$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) '学习计时.lnk'
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = $exe
$sc.Arguments = '"' + $App + '"'
$sc.WorkingDirectory = $App
$sc.IconLocation = "$exe,0"
$sc.Description = '学习计时：输入任务名（可加分钟）回车即计时'
$sc.Save()

Write-Host ""
Write-Host "装好了：桌面出现「学习计时」" -ForegroundColor Green
Write-Host "程序目录：$Root"
Write-Host "数据目录：$(Join-Path $Root 'data')"