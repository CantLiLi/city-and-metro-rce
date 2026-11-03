#!/usr/bin/env python3
"""构建桌面安装包。

Windows: PyInstaller 打成目录式应用（dist/CityAndMetroRCE/），再用 Inno Setup 打成 Setup .exe。
macOS:   PyInstaller 打成 .app，再用 hdiutil 生成 .dmg。
Inno Setup 只有 Windows 版，所以 .dmg 在 macOS 上用系统自带工具出，两边同一个入口。

用法（在仓库根目录执行）:
    python src/python/build.py                 # 当前平台，读版本号自动出包
    python src/python/build.py --platform win  # 指定平台（不能交叉编译）
    python src/python/build.py --no-installer  # 只打 dist 目录 / .app，不做安装包
    python src/python/build.py --clean         # 先清掉 dist/build
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

PY_DIR = Path(__file__).resolve().parent
SRC = PY_DIR.parent
ROOT = SRC.parent
DIST = ROOT / 'dist'
BUILD = ROOT / 'build'
CACHE = ROOT / '.tmp' / 'build'

APP_ID = 'city-and-metro-rce'
APP_NAME = '城市与地铁 RCE 社区版'
APP_NAME_ASCII = 'CityAndMetroRCE'
APP_PUBLISHER = 'VinsonFung'
APP_URL = 'https://github.com/CantLiLi/city-and-metro-rce'
ENTRY = PY_DIR / 'app.py'
ICON_ICO = SRC / 'img' / (APP_ID + '-icon.ico')
MAC_BUNDLE_ID = 'com.vinsonfung.cityandmetrorce'

HIDDEN_IMPORTS = ['webview.platforms.edgechromium', 'webview.platforms.winforms',
                  'webview.platforms.cocoa', 'clr_loader', 'pythonnet']
COLLECT_DATA = ['webview']
EXCLUDES = ['tkinter', 'unittest', 'pydoc_data', 'test', 'lib2to3', 'setuptools', 'pip']


def log(msg):
    print('[build] ' + msg, flush=True)


def fail(msg):
    raise SystemExit('[build] 错误: ' + msg)


def read_version():
    """版本号只认 config.js 的 GAME_VERSION，避免两处各写一个。"""
    path = SRC / 'js' / 'core' / 'config.js'
    m = re.search(r"GAME_VERSION\s*:\s*'([^']+)'", path.read_text(encoding='utf-8'))
    if not m:
        fail('在 src/js/core/config.js 里找不到 GAME_VERSION')
    return m.group(1)


def run(cmd, cwd=None, env=None):
    log('$ ' + ' '.join(str(c) for c in cmd))
    subprocess.run([str(c) for c in cmd], cwd=str(cwd or ROOT), env=env, check=True)


def detect_platform():
    if sys.platform.startswith('win'):
        return 'win'
    if sys.platform == 'darwin':
        return 'mac'
    return 'linux'


def ensure_dirs():
    DIST.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)


def clean():
    for path in (BUILD, DIST):
        if path.exists():
            log('清理 ' + str(path.relative_to(ROOT)))
            shutil.rmtree(path)


def pyinstaller_env():
    """临时目录压进工程的 .tmp，跑完自己清掉。"""
    env = os.environ.copy()
    tmp = CACHE / 'tmp'
    tmp.mkdir(parents=True, exist_ok=True)
    env.setdefault('PYINSTALLER_CONFIG_DIR', str(CACHE / 'pyinstaller'))
    for key in ('TEMP', 'TMP', 'TMPDIR'):
        env[key] = str(tmp)
    return env


def drop_tree(path):
    """清目录；个别文件删不掉（被杀毒/索引占用）就算了，不能让打包收尾失败。"""
    def on_error(func, target, exc):
        log('跳过无法删除的文件 ' + str(target))
    shutil.rmtree(str(path), onerror=on_error)


def pyinstaller(platform, version):
    cmd = [sys.executable, '-m', 'PyInstaller',
           '--noconfirm', '--clean', '--log-level', 'WARN',
           '--workpath', str(BUILD),
           '--distpath', str(DIST),
           '--specpath', str(CACHE),
           '--name', APP_NAME_ASCII,
           '--add-data', str(SRC) + os.pathsep + 'src',
           '--paths', str(PY_DIR)]
    for mod in HIDDEN_IMPORTS:
        cmd += ['--hidden-import', mod]
    for mod in COLLECT_DATA:
        cmd += ['--collect-data', mod]
    for mod in EXCLUDES:
        cmd += ['--exclude-module', mod]

    # 一律 onedir：单文件每次启动都要把几百 MB 解包到临时目录，慢且杀毒易拦。
    cmd += ['--onedir', '--windowed']
    if platform == 'win':
        cmd += ['--version-file', str(write_version_file(version))]
        if ICON_ICO.is_file():
            cmd += ['--icon', str(ICON_ICO)]
    elif platform == 'mac':
        cmd += ['--osx-bundle-identifier', MAC_BUNDLE_ID]
        icon = mac_icns()
        if icon:
            cmd += ['--icon', str(icon)]
    cmd.append(str(ENTRY))
    run(cmd, env=pyinstaller_env())


def _version_tuple(version):
    nums = [int(p) if p.isdigit() else 0
            for p in re.split(r'[.\-+]', version) if p]
    while len(nums) < 4:
        nums.append(0)
    return nums[:4]


def write_version_file(version):
    """Windows 资源里写版本号与产品名，exe 属性页和任务栏才不显示 Python。"""
    a, b, c, d = _version_tuple(version)
    file_version = '%d.%d.%d.%d' % (a, b, c, d)
    text = """# 由 build.py 生成
VSVersionInfo(
  ffi=FixedFileInfo(
    filevers=(%d, %d, %d, %d),
    prodvers=(%d, %d, %d, %d),
    mask=0x3f, flags=0x0, OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)
  ),
  kids=[
    StringFileInfo([StringTable('080404b0', [
      StringStruct('CompanyName', %r),
      StringStruct('FileDescription', %r),
      StringStruct('FileVersion', %r),
      StringStruct('InternalName', %r),
      StringStruct('LegalCopyright', 'Copyright (c) 2026 %s'),
      StringStruct('OriginalFilename', %r),
      StringStruct('ProductName', %r),
      StringStruct('ProductVersion', %r)])]),
    VarFileInfo([VarStruct('Translation', [2052, 1200])])
  ]
)
""" % (a, b, c, d, a, b, c, d,
       APP_PUBLISHER, APP_NAME, file_version, APP_NAME_ASCII, APP_PUBLISHER,
       APP_NAME_ASCII + '.exe', APP_NAME, file_version)
    path = CACHE / 'version_info.txt'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')
    return path


def mac_icns():
    """有 icns 就用；没有就从 favicon.png 生成。返回 None 表示不设图标。"""
    icns = SRC / 'img' / (APP_ID + '.icns')
    if icns.is_file():
        return icns
    png = SRC / 'img' / 'favicon.png'
    if not png.is_file():
        log('缺少 src/img/%s.icns 与 favicon.png，跳过图标' % APP_ID)
        return None
    out = CACHE / 'icon.icns'
    iconset = CACHE / 'icon.iconset'
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir(parents=True)
    for size in (16, 32, 128, 256, 512):
        for scale, tag in ((1, ''), (2, '@2x')):
            side = size * scale
            target = iconset / ('icon_%dx%d%s.png' % (size, size, tag))
            run(['sips', '-z', str(side), str(side), str(png), '--out', str(target)])
    run(['iconutil', '-c', 'icns', str(iconset), '-o', str(out)])
    return out


# ---------------- Windows: Inno Setup ----------------

INNO_SCRIPT = """\
; 由 build.py 生成，不要手改
#define AppName "%(name)s"
#define AppVersion "%(version)s"
#define AppPublisher "%(publisher)s"
#define AppURL "%(url)s"
#define AppExe "%(exe)s"

[Setup]
AppId={{%(appid)s}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}
VersionInfoVersion=%(version4)s
VersionInfoCompany={#AppPublisher}
VersionInfoDescription={#AppName} Setup
DefaultDirName={autopf}\\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\\{#AppExe}
UninstallDisplayName={#AppName}
OutputDir={#MyOutDir}
OutputBaseFilename={#MyBaseName}
SetupIconFile=%(icon)s
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
LZMAUseSeparateProcess=yes
ArchitecturesAllowed=%(archs)s
ArchitecturesInstallIn64BitMode=%(install64)s
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog commandline

[Languages]
%(languages)s

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "%(app_dir)s\\*"; DestDir: "{app}"; Excludes: "\\.tmp\\*,__pycache__,*.pyc"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "%(license)s"; DestDir: "{app}"; DestName: "LICENSE.txt"; Flags: ignoreversion
Source: "%(notices)s"; DestDir: "{app}"; DestName: "THIRD_PARTY_NOTICES.txt"; Flags: ignoreversion

[Icons]
Name: "{group}\\{#AppName}"; Filename: "{app}\\{#AppExe}"
Name: "{group}\\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\\{#AppName}"; Filename: "{app}\\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\\.tmp"
"""


def inno_compiler():
    for name in ('iscc', 'ISCC.exe', 'ISCC'):
        path = shutil.which(name)
        if path:
            return path
    for base in (os.environ.get('ProgramFiles(x86)'), os.environ.get('ProgramFiles')):
        if not base:
            continue
        for folder in ('Inno Setup 6', 'Inno Setup 5'):
            path = Path(base) / folder / 'ISCC.exe'
            if path.is_file():
                return str(path)
    return None


def build_installer_win(version):
    iscc = inno_compiler()
    if not iscc:
        fail('找不到 ISCC.exe（Inno Setup 6），安装后重试或加 --no-installer')

    app_dir = DIST / APP_NAME_ASCII
    if not (app_dir / (APP_NAME_ASCII + '.exe')).is_file():
        fail('没有找到 ' + str(app_dir / (APP_NAME_ASCII + '.exe')))

    setup_name = '%s-%s-setup' % (APP_ID, version)
    chinese = Path(iscc).parent / 'Languages' / 'ChineseSimplified.isl'
    languages = 'Name: "english"; MessagesFile: "compiler:Default.isl"'
    if chinese.is_file():
        languages = ('Name: "chinesesimp"; MessagesFile: "%s"\n' % chinese.as_posix()) + languages
    else:
        log('Inno Setup 没有简体中文语言文件，安装向导用英文')

    script = CACHE / 'installer.iss'
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text(INNO_SCRIPT % {
        'name': APP_NAME,
        'version': version,
        'version4': '.'.join(str(n) for n in _version_tuple(version)),
        'publisher': APP_PUBLISHER,
        'url': APP_URL,
        'exe': APP_NAME_ASCII + '.exe',
        'appid': MAC_BUNDLE_ID + '-win',
        'languages': languages,
        'icon': str(ICON_ICO) if ICON_ICO.is_file() else '',
        'archs': 'x64',
        'install64': 'x64',
        'app_dir': str(app_dir),
        'license': str(SRC / 'LICENSE.txt'),
        'notices': str(SRC / 'THIRD_PARTY_NOTICES.txt'),
    }, encoding='utf-8')

    run([iscc, '/Qp', '/DMyOutDir=' + str(DIST), '/DMyBaseName=' + setup_name, str(script)])
    out = DIST / (setup_name + '.exe')
    if not out.is_file():
        fail('Inno Setup 没有生成 ' + str(out))
    return out


# ---------------- macOS: dmg ----------------

def write_entitlements():
    path = CACHE / 'entitlements.plist'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
""", encoding='utf-8')
    return path


def sign_app(app):
    identity = os.environ.get('CITY_METRO_CODESIGN_IDENTITY')
    if not identity:
        log('未设置 CITY_METRO_CODESIGN_IDENTITY，跳过签名（首次打开需右键 → 打开）')
        return
    run(['codesign', '--deep', '--force', '--options', 'runtime',
         '--entitlements', str(write_entitlements()), '--sign', identity, str(app)])


def build_dmg(version):
    app = DIST / (APP_NAME_ASCII + '.app')
    if not app.is_dir():
        fail('没有找到 ' + str(app))

    sign_app(app)

    stage = CACHE / 'dmg'
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    run(['ditto', str(app), str(stage / app.name)])
    (stage / 'Applications').symlink_to('/Applications')

    dmg = DIST / ('%s-%s.dmg' % (APP_ID, version))
    if dmg.exists():
        dmg.unlink()
    run(['hdiutil', 'create', '-volname', APP_NAME, '-srcfolder', str(stage),
         '-ov', '-format', 'UDZO', '-fs', 'HFS+', str(dmg)])
    return dmg


def codesign_dmg(dmg):
    identity = os.environ.get('CITY_METRO_CODESIGN_IDENTITY')
    if not identity:
        return dmg
    run(['codesign', '--force', '--sign', identity, str(dmg)])
    profile = os.environ.get('CITY_METRO_NOTARY_PROFILE')
    if profile:
        run(['xcrun', 'notarytool', 'submit', str(dmg), '--keychain-profile', profile, '--wait'])
        run(['xcrun', 'stapler', 'staple', str(dmg)])
    return dmg


def ensure_tools():
    missing = []
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        missing.append('PyInstaller')
    try:
        import webview  # noqa: F401
    except ImportError:
        missing.append('pywebview')
    if detect_platform() == 'win' and not inno_compiler():
        fail('找不到 ISCC.exe（Inno Setup 6），请先安装：https://jrsoftware.org/isdl.php')
    if missing:
        fail('缺少依赖，先运行: %s -m pip install %s'
             % (Path(sys.executable).name, ' '.join(missing)))


def main(argv=None):
    parser = argparse.ArgumentParser(description='打包桌面版安装包')
    parser.add_argument('--platform', choices=['win', 'mac'], default=None)
    parser.add_argument('--no-installer', action='store_true', help='只打 exe / app')
    parser.add_argument('--clean', action='store_true', help='先清理 dist 与 build')
    parser.add_argument('--version', default=None, help='覆盖版本号（默认读 src/js/core/config.js）')
    args = parser.parse_args(argv)

    target = args.platform or detect_platform()
    if target != detect_platform():
        fail('不能跨平台打包：当前是 %s，目标是 %s' % (detect_platform(), target))
    if target == 'linux':
        fail('只支持 Windows 与 macOS')

    version = args.version or read_version()
    log('版本 %s，平台 %s' % (version, target))
    if args.clean:
        clean()
    ensure_dirs()
    ensure_tools()

    pyinstaller(target, version)
    if args.no_installer:
        log('完成：' + str(DIST))
        return 0

    if target == 'win':
        out = build_installer_win(version)
    else:
        out = codesign_dmg(build_dmg(version))
    log('安装包：' + str(out))
    if CACHE.is_dir():
        drop_tree(CACHE)
    return 0


if __name__ == '__main__':
    sys.exit(main())
