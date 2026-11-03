"""桌面版启动器。

职责：找到网页资源 → 启动本地 HTTP 服务器 → 打开 pywebview 窗口 →
把窗口桥接到 bridge 的存储/对话框/窗口控制 → 关窗前等页面把进度写完。
Windows 用 WebView2，macOS 用 Cocoa/WebKit；两者都跑在标准线程模型上。
"""

import argparse
import json
import os
import sys
import tempfile
import threading
import time

import bridge

APP_NAME = bridge.APP_TITLE
APP_ID = bridge.APP_ID
MIN_SIZE = (1024, 680)
DEFAULT_SIZE = (1440, 900)
BACKGROUND = '#eaf1f7'
CLOSE_GRACE = 2.0
FORCE_EXIT = 6.0
DEVTOOLS = True
PAGE_KEYS = ('page', 'title', 'map', 'gameId', 'unsaved')

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.dirname(HERE)


def page_root():
    """开发时页面在仓库的 src 目录；打包后（PyInstaller）在解包目录。"""
    if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, 'src')
    return SRC_DIR


def icon_path():
    """WinForms 的 Icon 只认 .ico：给它 PNG 会在 GUI 线程抛 ArgumentException 把进程带走。

    src/img 下放的是现成的 ico；没有就返回 None，交给 pywebview 用 exe 自带的图标兜底。
    """
    for name in (APP_ID + '-icon.ico', 'favicon.ico', 'favicon.icns'):
        path = os.path.join(page_root(), 'img', name)
        if os.path.isfile(path):
            return path
    return None


def game_root():
    """游戏本体所在目录：打包后是 exe 目录，开发时是仓库根目录。"""
    if getattr(sys, 'frozen', False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(SRC_DIR)


def profile_dir():
    """WebView2 的数据目录（EBWebView）。

    不给 storage_path 时 pywebview 会开 private_mode，把缓存塞进系统临时目录的
    tmpXXXX 里，退出还不清；给一个固定目录，内核缓存才有稳定的家。
    """
    return os.path.join(game_root(), '.tmp', 'webview')


def data_dir(argv_dir=None):
    if argv_dir:
        return os.path.abspath(os.path.expanduser(argv_dir))
    env = os.environ.get('CITY_AND_METRO_DATA')
    if env:
        return os.path.abspath(os.path.expanduser(env))
    home = os.path.expanduser('~')
    local = game_root()
    candidates = []
    if sys.platform == 'darwin':
        candidates.append(os.path.join(home, 'Library', 'Application Support', 'CityAndMetroRCE'))
    elif sys.platform.startswith('win'):
        candidates.append(os.path.join(os.environ.get('LOCALAPPDATA') or
                                       os.path.join(home, 'AppData', 'Local'), 'CityAndMetroRCE'))
    else:
        candidates.append(os.path.join(os.environ.get('XDG_DATA_HOME') or
                                       os.path.join(home, '.local', 'share'), 'city-and-metro-rce'))
    candidates.append(os.path.join(local, 'data'))
    for path in candidates:
        if writable(path):
            return path
    return candidates[0]


def writable(path):
    """确认目录能建、能写：两个候选位置都不可用时才不会启动即崩。"""
    try:
        os.makedirs(path, exist_ok=True)
        probe = os.path.join(path, '.write-test')
        with open(probe, 'wb') as f:
            f.write(b'ok')
        os.remove(probe)
        return True
    except OSError:
        return False


class Session:
    """一次运行的共享状态：页面心跳、关窗握手、偏好缓存。"""

    def __init__(self, folder):
        self.folder = folder
        self.lock = threading.RLock()
        self.page = {}
        self.prefs = bridge.prefs_read()
        self.quit_ack = threading.Event()
        self.closing = False
        self.window = None
        self.port = 0
        self.launched = time.time()

    def info(self):
        with self.lock:
            page = dict(self.page)
        return {
            'app': APP_ID,
            'name': APP_NAME,
            'apiVersion': 1,
            'platform': sys.platform,
            'dataDir': self.folder,
            'recoverDir': bridge._state.get('snapshot') or '',
            'prefs': self.prefs,
            'storage': bridge.storage_meta([]),
            'recovered': bridge.recover_list(),
            'page': page,
            'restored': bool(page) and page.get('unsaved') is True,
            'pid': os.getpid(),
        }

    def heartbeat(self, body):
        if not isinstance(body, dict):
            return False
        with self.lock:
            for key in PAGE_KEYS:
                if key in body:
                    self.page[key] = body[key]
        if body.get('quit'):
            # 先放行关窗，清理放到后台：扫目录可能在几万个文件上跑很久，
            # 这时候窗口还杵在那儿等，用户只会觉得「点了叉没反应」。
            self.quit_ack.set()
            threading.Thread(target=bridge_temp_cleanup, daemon=True).start()
        return True

    def page_state(self):
        with self.lock:
            return dict(self.page)

    def snapshot(self, payload):
        if not isinstance(payload, dict):
            return False
        body = dict(payload)
        body['app'] = APP_ID
        body['pid'] = os.getpid()
        body['dataDir'] = self.folder
        body['at'] = int(time.time())
        name = 'unsaved-' + str(body.get('gameId') or 'game')[:60] + '-' + str(body['at']) + '.json'
        name = ''.join(ch for ch in name if ch not in '/\\:*?"<>|')
        path = os.path.join(bridge._state['snapshot'], name)
        try:
            bridge.write_atomic(path, json.dumps(body, ensure_ascii=False).encode('utf-8'))
            return True
        except (OSError, KeyError):
            return False


def bridge_temp_cleanup():
    try:
        bridge.sweep()
    except OSError:
        pass


class Api:
    """暴露给页面 window.pywebview.api 的方法名（白名单）。

    pywebview 会把 js_api 对象的公开属性递归反射成 window.pywebview.api，遇到
    Session / Window / COM 这类非方法对象会一路展开到 native.AccessibilityObject
    这种每次都返回新实例的属性，最后刷满 "maximum recursion depth exceeded" 与 COM 告警。
    给展开到的对象打 _serializable = False，反射就地停下。
    """

    def __init__(self, session):
        self.session = session
        self.session._serializable = False

    def desktopInfo(self):
        return bridge.reply(self.session.info())

    def store(self, payload):
        return bridge.reply(bridge.store_request(bridge.parse(payload)))

    def heartbeat(self, payload):
        body = bridge.parse(payload)
        return bridge.reply({'ok': self.session.heartbeat(body)})

    def prefs(self, payload):
        request = bridge.parse(payload)
        values = request.get('set') or {}
        try:
            current = bridge.prefs_write(values)
            self.session.prefs = current
            return bridge.reply({'ok': True, 'prefs': current})
        except OSError as e:
            return bridge.reply({'ok': False, 'error': str(e)})

    def export(self, payload):
        return bridge.reply(bridge.export_request(bridge.parse(payload)))

    def importFile(self, payload):
        return bridge.reply(bridge.import_request())

    def window(self, payload):
        return bridge.reply({'ok': bool(bridge.window_request(bridge.parse(payload)))})

    def snapshot(self, payload):
        return bridge.reply({'ok': self.session.snapshot(bridge.parse(payload))})

    def recover(self, payload):
        request = bridge.parse(payload)
        action = str(request.get('action') or 'list')
        if action == 'read':
            return bridge.reply({'ok': True, 'text': bridge.recover_read(request.get('name'))})
        if action == 'drop':
            return bridge.reply({'ok': bridge.recover_drop(request.get('name'))})
        return bridge.reply({'ok': True, 'items': bridge.recover_list()})

    def quit(self, payload):
        window = self.session.window
        if window is not None:
            threading.Thread(target=bridge.close_window, args=(window,), daemon=True).start()
        return bridge.reply({'ok': True})


def _enable_dpi():
    if not sys.platform.startswith('win'):
        return
    try:
        import ctypes
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


def _taskbar_identity():
    """让任务栏按本应用分组，而不是挂在 python.exe 上继续显示 Python 图标。"""
    if not sys.platform.startswith('win'):
        return
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)
    except Exception:
        pass


def _mac_menu():
    """macOS 上设置应用菜单与 Dock 名称（没有 pyobjc 时静默跳过）。"""
    try:
        from AppKit import NSApplication, NSMenu, NSMenuItem
        from Foundation import NSProcessInfo
        NSProcessInfo.processInfo().setProcessName_(APP_NAME)
        app = NSApplication.sharedApplication()
        main_menu = NSMenu.alloc().init()
        item = NSMenuItem.alloc().init()
        submenu = NSMenu.alloc().initWithTitle_(APP_NAME)
        submenu.addItemWithTitle_action_keyEquivalent_('关于 ' + APP_NAME, 'orderFrontStandardAboutPanel:', '')
        submenu.addItem_(NSMenuItem.separatorItem())
        submenu.addItemWithTitle_action_keyEquivalent_('隐藏 ' + APP_NAME, 'hide:', 'h')
        submenu.addItemWithTitle_action_keyEquivalent_('退出 ' + APP_NAME, 'terminate:', 'q')
        item.setSubmenu_(submenu)
        main_menu.addItem_(item)
        app.setMainMenu_(main_menu)
    except Exception:
        pass


def _prepare_temp():
    """pythonnet 会在系统临时目录里建 runtimeconfig.json，TEMP 不可写时换到本地目录。"""
    try:
        probe = tempfile.mkdtemp(prefix=APP_ID + '-')
        os.rmdir(probe)
    except OSError:
        local = os.path.join(game_root(), '.tmp')
        os.makedirs(local, exist_ok=True)
        for name in ('TMPDIR', 'TEMP', 'TMP'):
            os.environ[name] = local
        tempfile.tempdir = local


DESKTOP_FRAMEWORK = 'Microsoft.WindowsDesktop.App'
DESKTOP_VERSIONS = ('10.0', '8.0')


def _desktop_dlls(version):
    """Microsoft.WindowsDesktop.App 共享框架里的程序集（System.Windows.Forms 等）。"""
    root = os.environ.get('DOTNET_ROOT') or os.path.join(
        os.environ.get('ProgramFiles') or 'C:\\Program Files', 'dotnet')
    shared = os.path.join(root, 'shared', DESKTOP_FRAMEWORK)
    try:
        folders = [n for n in os.listdir(shared) if n.startswith(version + '.')]
    except OSError:
        return []
    if not folders:
        return []
    folder = os.path.join(shared, sorted(folders)[-1])
    try:
        return [os.path.join(folder, n) for n in os.listdir(folder) if n.lower().endswith('.dll')]
    except OSError:
        return []


def _prepare_runtime():
    """pythonnet 3.2 不自带 CLR 初始化：显式挂上 .NET Core。

    coreclr 默认的 TPA 里没有 WindowsDesktop 框架，System.Windows.Forms 会缺
    ContextMenu 这类只在桌面框架里的类型（pythonnet 建类型时直接 TypeLoadException），
    所以把共享框架目录里的程序集补进 TRUSTED_PLATFORM_ASSEMBLIES。
    """
    if 'clr' in sys.modules:
        return
    try:
        import pythonnet
        import clr_loader
    except ImportError:
        return
    if pythonnet._RUNTIME is not None:
        return
    folder = os.path.join(game_root(), '.tmp')
    try:
        os.makedirs(folder, exist_ok=True)
    except OSError:
        return
    for version in DESKTOP_VERSIONS:
        desktop = _desktop_dlls(version)
        if not desktop:
            continue
        config = os.path.join(folder, 'runtimeconfig.json')
        try:
            with open(config, 'w', encoding='utf-8') as f:
                json.dump({'runtimeOptions': {'tfm': 'net' + version, 'framework': {
                    'name': DESKTOP_FRAMEWORK, 'version': version + '.0'}}}, f)
            runtime = clr_loader.get_coreclr(runtime_config=config)
            runtime['TRUSTED_PLATFORM_ASSEMBLIES'] = \
                runtime['TRUSTED_PLATFORM_ASSEMBLIES'] + os.pathsep + os.pathsep.join(desktop)
        except Exception:
            continue
        pythonnet.set_runtime(runtime)
        return


def run(folder, debug=None):
    if debug is None:
        debug = DEVTOOLS
    _prepare_temp()
    _prepare_runtime()
    import webview
    bridge.configure(folder)
    bridge.sweep()
    bridge.adopt_stray()
    session = Session(folder)
    api = Api(session)
    root = page_root()
    page = os.path.join(root, 'index.html')
    if not os.path.isfile(page):
        raise SystemExit('找不到页面文件：' + page)

    if sys.platform == 'darwin':
        _mac_menu()

    window = webview.create_window(
        APP_NAME,
        url=page,
        js_api=api,
        width=DEFAULT_SIZE[0],
        height=DEFAULT_SIZE[1],
        min_size=MIN_SIZE,
        background_color=BACKGROUND,
        text_select=True,
        zoomable=True,
        confirm_close=False,
        localization={'global.quitConfirmation': '确定要关闭吗？'},
    )

    def on_closing():
        # 这个回调是在 GUI 线程上同步跑的：这里每停一秒，窗口就多僵一秒。
        # 所以只催一声页面存盘、稍微等一下，绝不把整段时间耗在等待上；
        # 真正的兜底交给定时强制退出。
        session.closing = True
        _start_force_exit()
        threading.Thread(target=_ask_page_to_save, args=(session,), daemon=True).start()
        session.quit_ack.wait(CLOSE_GRACE)

    def on_loaded():
        session.port = getattr(window, 'port', 0) or 0

    window.events.closing += on_closing
    window.events.loaded += on_loaded
    session.window = window
    bridge.attach(window)
    webview.start(private_mode=False, storage_path=profile_dir(), http_server=True,
                  debug=debug, icon=icon_path())
    return session


def _start_force_exit():
    """窗口关掉后进程还没结束就自己走：内核线程和存档线程都不该把人卡在窗口前。"""
    timer = threading.Timer(FORCE_EXIT, _force_exit)
    timer.daemon = True
    timer.start()
    return timer


def _force_exit():
    os._exit(0)


def _ask_page_to_save(session):
    window = session.window
    if window is None:
        return
    try:
        window.run_js('window.CM && CM.onCloseRequest && CM.onCloseRequest();')
    except Exception:
        return


def main(argv=None):
    parser = argparse.ArgumentParser(description=APP_NAME)
    parser.add_argument('--data-dir', default=None)
    parser.add_argument('--debug', action=argparse.BooleanOptionalAction, default=None,
                        help='打开网页开发者工具（F12 / 右键检查）；不传则用 app.DEVTOOLS 的默认值')
    parser.add_argument('--snapshot', default=None, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    _enable_dpi()
    _taskbar_identity()
    session = run(data_dir(args.data_dir), debug=args.debug)
    return 0 if session is not None else 1


if __name__ == '__main__':
    sys.exit(main())
