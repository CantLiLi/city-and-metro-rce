"""桌面版（pywebview）与网页之间的桥接层。

只负责传输：存档文件读写、偏好设置、导入导出对话框、窗口控制与关窗前握手。
所有数据都以字符串形式往返，Python 侧不解析存档内容。
"""

import base64
import json
import os
import tempfile
import threading

APP_ID = 'city-and-metro-rce'
APP_TITLE = '城市与地铁 RCE 社区版'
COPY_SUFFIX = '.tmp-copy'
TMP_PREFIX = '.cm-'
MAX_IMPORT = 30 * 1024 * 1024
FORCE_EXIT = 5.0
INDEX_NAME = 'index.json'
SAVE_FORMAT = 'city-metro-save'

_lock = threading.RLock()
_state = {'window': None, 'dataDir': '', 'snapshot': None, 'cache': None}


def data_dir():
    return _state['dataDir']


def configure(path):
    folder = os.path.abspath(path)
    os.makedirs(folder, exist_ok=True)
    _state['dataDir'] = folder
    _state['snapshot'] = _open_recover(folder)
    _state['cache'] = _open_cache(folder)


def _open_recover(folder):
    target = os.path.join(folder, 'recover')
    os.makedirs(target, exist_ok=True)
    return target


def _open_cache(folder):
    target = os.path.join(folder, 'traffic-cache')
    os.makedirs(target, exist_ok=True)
    return target


def attach(window):
    _state['window'] = window


# ---------------- 文件读写 ----------------

def safe_name(key):
    """键名直接作为文件名：拒绝任何能跳出数据目录或 Windows 不接受的写法。"""
    name = str(key or '')
    if (not name or name in ('.', '..') or '/' in name or '\\' in name
            or ':' in name or '\x00' in name or len(name) > 180):
        return None
    return name


def _path(key):
    name = safe_name(key)
    return os.path.join(_state['dataDir'], name) if name else None


def _drop(path):
    try:
        os.remove(path)
    except OSError:
        pass


def _read_text(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def _write_bytes(path, data):
    folder = os.path.dirname(path) or '.'
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=TMP_PREFIX, suffix='.tmp', dir=folder)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        _drop(tmp)
        raise


def write_atomic(path, data, copy=False):
    """临时文件 → 校验 → 替换：中途退出只会留下完整副本，不会破坏原文件。"""
    folder = os.path.dirname(path) or '.'
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=TMP_PREFIX, suffix='.tmp', dir=folder)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        with open(tmp, 'rb') as f:
            if f.read() != data:
                raise OSError('写入后校验失败')
        if copy:
            with open(tmp + COPY_SUFFIX, 'wb') as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        _drop(tmp)
        _drop(tmp + COPY_SUFFIX)
        raise
    if copy:
        _drop(tmp + COPY_SUFFIX)
        _drop(path + COPY_SUFFIX)


def intact(text):
    if not text or not text.startswith('{'):
        return False
    try:
        json.loads(text)
        return True
    except ValueError:
        return False


def repair(keys):
    """上次写入在替换前中断：用留底副本还原，没有留底则清掉写坏的半份数据。"""
    fixed = []
    for key in keys:
        path = _path(key)
        if not path:
            continue
        copy = path + COPY_SUFFIX
        if not os.path.exists(path):
            _drop(copy)
            continue
        if os.path.exists(copy):
            try:
                os.replace(copy, path)
                fixed.append(key)
                continue
            except OSError:
                pass
        try:
            text = _read_text(path)
        except OSError:
            text = None
        if intact(text):
            continue
        _drop(path)
        fixed.append(key)
    return fixed


def sweep():
    """清理中断写入留下的临时文件；留底副本只在原文件完好时删除。"""
    folder = _state['dataDir']
    dropped = []
    try:
        entries = list(os.scandir(folder))
    except OSError:
        return dropped
    for entry in entries:
        if not entry.name.startswith(TMP_PREFIX):
            continue
        # 写入用的临时文件（含写 .tmp-copy 时中断留下的 X.tmp.tmp-copy）都没有保留价值
        try:
            _drop(entry.path)
            dropped.append(entry.name)
        except OSError:
            pass
    for entry in entries:
        if not entry.name.endswith(COPY_SUFFIX):
            continue
        original = entry.path[:-len(COPY_SUFFIX)]
        if not os.path.exists(original):
            continue
        try:
            if intact(_read_text(original)):
                _drop(entry.path)
        except OSError:
            continue
    return dropped


def adopt_stray():
    """关闭时没来得及落盘的快照改名收编，下次启动可在恢复目录看到。"""
    folder = _state['snapshot']
    moved = []
    try:
        entries = list(os.scandir(folder))
    except OSError:
        return moved
    for entry in entries:
        if not (entry.name.startswith(TMP_PREFIX) and entry.name.endswith('.tmp')):
            continue
        try:
            if not intact(_read_text(entry.path)):
                continue
            base = os.path.join(folder, entry.name[len(TMP_PREFIX):-4])
            target, index = base + '.json', 1
            while os.path.exists(target):
                target = base + '-' + str(index) + '.json'
                index += 1
            os.replace(entry.path, target)
            moved.append(os.path.basename(target))
        except OSError:
            continue
    return moved


def recover_list():
    out = []
    folder = _state['snapshot']
    if not folder:
        return out
    try:
        for entry in os.scandir(folder):
            if entry.is_file() and entry.name.endswith('.json') and not entry.name.startswith('.'):
                try:
                    out.append({'name': entry.name, 'bytes': entry.stat().st_size})
                except OSError:
                    continue
    except OSError:
        pass
    out.sort(key=lambda x: x['name'], reverse=True)
    return out


def recover_read(name):
    folder = _state['snapshot']
    if not folder or safe_name(name) is None:
        return None
    path = os.path.join(folder, name)
    if os.path.dirname(os.path.abspath(path)) != os.path.abspath(folder):
        return None
    try:
        return _read_text(path)
    except OSError:
        return None


def recover_drop(name):
    folder = _state['snapshot']
    if not folder or safe_name(name) is None:
        return False
    path = os.path.join(folder, name)
    if os.path.dirname(os.path.abspath(path)) != os.path.abspath(folder):
        return False
    _drop(path)
    return True


# ---------------- 偏好设置 ----------------

def prefs_path():
    return os.path.join(_state['dataDir'], 'prefs.json')


def prefs_read():
    try:
        return json.loads(_read_text(prefs_path()))
    except (OSError, ValueError):
        return {}


def prefs_write(values):
    current = prefs_read()
    if not isinstance(current, dict):
        current = {}
    for key, value in (values or {}).items():
        if value is None:
            current.pop(str(key), None)
        else:
            current[str(key)] = value
    write_atomic(prefs_path(), json.dumps(current, ensure_ascii=False).encode('utf-8'))
    return current


# ---------------- 收发 ----------------

def reply(obj):
    return json.dumps(obj, ensure_ascii=False)


def parse(payload):
    try:
        request = json.loads(payload) if isinstance(payload, str) else (payload or {})
    except ValueError:
        return {}
    return request if isinstance(request, dict) else {}


def storage_meta(keys):
    out = {'ok': True, 'store': 'file', 'label': '本地文件', 'dataDir': _state['dataDir'],
           'repaired': [], 'swept': [], 'recovered': recover_list(), 'unreadable': []}
    try:
        out['repaired'] = repair(keys or [])
    except OSError as e:
        out['error'] = str(e)
    try:
        out['swept'] = sweep()
    except OSError:
        pass
    try:
        text = _read_text(os.path.join(_state['dataDir'], 'index.json'))
    except OSError:
        text = ''
    if text and not intact(text):
        out['unreadable'].append('index.json')
    return out


def _slot_entry(name, text):
    """从存档文件正文反解清单条目：键就是文件名，其余来自存档信封与正文。"""
    try:
        env = json.loads(text)
    except ValueError:
        return None
    if not isinstance(env, dict) or env.get('format') != SAVE_FORMAT or not isinstance(env.get('body'), str):
        return None
    try:
        payload = json.loads(env['body'])
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None
    meta = payload.get('meta') or {}
    clock = payload.get('clock') or {}
    econ = payload.get('econ') or {}
    net = payload.get('net') or {}
    game_id = str(meta.get('gameId') or '')
    slot_id = str(meta.get('slotId') or '')
    if not game_id or not slot_id:
        return None
    kind = meta.get('kind')
    if kind not in ('auto', 'manual', 'backup'):
        kind = 'manual'
    try:
        date = [int(clock.get('y') or 0), int(clock.get('m') or 0), int(clock.get('d') or 0)]
    except (TypeError, ValueError):
        date = [0, 0, 0]
    funds = None if econ.get('mode') == 'free' else econ.get('funds')
    return {
        'slot': {
            'slotId': slot_id, 'key': name, 'store': 'file', 'gameId': game_id, 'kind': kind,
            'label': str(meta.get('label') or ('自动存档' if kind == 'auto' else ('手动存档' if kind == 'manual' else '升级前备份'))),
            'date': date, 'savedAt': int(env.get('savedAt') or 0), 'size': len(text.encode('utf-8')),
            'mode': meta.get('mode'), 'name': meta.get('name'), 'map': meta.get('map') or 'gz',
            'stations': len((net.get('stations') or {})), 'funds': funds,
        },
        'game': {
            'gameId': game_id, 'name': meta.get('name'), 'mode': meta.get('mode'),
            'map': meta.get('map') or 'gz', 'createdAt': meta.get('createdAt'),
            'updatedAt': int(env.get('savedAt') or 0),
        },
    }


def rebuild_index():
    """按存档文件重新登记清单：清单损坏或文件被外部挪动后的最后手段。"""
    folder = _state['dataDir']
    slots = {}
    games = {}
    bad = []
    try:
        entries = list(os.scandir(folder))
    except OSError as e:
        return {'ok': False, 'error': str(e)}
    for entry in entries:
        name = entry.name
        if not entry.is_file() or name == INDEX_NAME or name.startswith('.') or '.' not in name:
            continue
        if name.endswith(COPY_SUFFIX):
            continue
        try:
            text = _read_text(entry.path)
        except OSError:
            continue
        found = _slot_entry(name, text)
        if not found:
            bad.append(name)
            continue
        slot = found['slot']
        # 同一槽位可能因为覆盖写入留下多份：留 savedAt 最新的一份，平手比文件名
        old = slots.get(slot['slotId'])
        if old and (old['savedAt'], old['key']) > (slot['savedAt'], slot['key']):
            continue
        slots[slot['slotId']] = slot
        game = games.get(slot['gameId'])
        if not game or game['updatedAt'] <= slot['savedAt']:
            games[slot['gameId']] = found['game']
    index = {'games': games, 'slots': slots}
    try:
        write_atomic(os.path.join(folder, INDEX_NAME),
                     json.dumps(index, ensure_ascii=False).encode('utf-8'), copy=True)
    except OSError as e:
        return {'ok': False, 'error': str(e)}
    return {'ok': True, 'index': index, 'skipped': bad}


def cache_dir():
    folder = _state.get('cache')
    if not folder:
        folder = _state['cache'] = _open_cache(_state['dataDir'])
    return folder


def cache_path(key):
    name = safe_name(key)
    return os.path.join(cache_dir(), name) if name else None


def cache_get(key):
    path = cache_path(key)
    if not path:
        return {'ok': True, 'meta': None, 'blob': None}
    try:
        raw = _read_text(path)
    except FileNotFoundError:
        return {'ok': True, 'meta': None, 'blob': None}
    except (OSError, ValueError) as e:
        return {'ok': False, 'error': str(e)}
    try:
        record = json.loads(raw)
        return {'ok': True, 'meta': record.get('meta'), 'blob': record.get('blob')}
    except (AttributeError, ValueError):
        return {'ok': True, 'meta': None, 'blob': None}


def cache_put(key, meta, blob):
    path = cache_path(key)
    if not path or not isinstance(meta, str) or not isinstance(blob, str):
        return {'ok': False, 'error': '缓存内容无效'}
    try:
        _write_bytes(path, json.dumps({'meta': json.loads(meta), 'blob': blob}).encode('utf-8'))
        return {'ok': True}
    except (OSError, ValueError) as e:
        return {'ok': False, 'error': str(e)}


def cache_list():
    out = []
    try:
        for entry in os.scandir(cache_dir()):
            if not entry.is_file():
                continue
            try:
                info = entry.stat()
                out.append({'key': entry.name, 'bytes': info.st_size, 'used': info.st_mtime})
            except OSError:
                continue
    except OSError:
        pass
    out.sort(key=lambda x: x['used'], reverse=True)
    return {'ok': True, 'list': out}


def cache_drop(keys):
    for key in keys or []:
        path = cache_path(key)
        if path:
            _drop(path)
    return {'ok': True}


def cache_touch(key):
    path = cache_path(key)
    if not path:
        return {'ok': False, 'error': '缓存键无效'}
    try:
        os.utime(path, None)
        return {'ok': True}
    except OSError:
        return {'ok': False, 'error': '缓存条目不存在'}


def store_request(request):
    op = str(request.get('op') or '')
    if op == 'meta':
        return storage_meta(request.get('keys'))
    if op == 'index':
        try:
            return {'ok': True, 'text': _read_text(os.path.join(_state['dataDir'], 'index.json'))}
        except FileNotFoundError:
            return {'ok': True, 'text': None}
        except OSError as e:
            return {'ok': False, 'error': str(e)}
    if op == 'indexSave':
        text = request.get('text')
        if not isinstance(text, str):
            return {'ok': False, 'error': '索引内容无效'}
        if not intact(text):
            return {'ok': False, 'error': '索引不是有效的 JSON，已拒绝写入'}
        try:
            write_atomic(os.path.join(_state['dataDir'], 'index.json'), text.encode('utf-8'), copy=True)
            return {'ok': True}
        except OSError as e:
            return {'ok': False, 'error': str(e)}
    if op == 'save':
        path = _path(request.get('key'))
        text = request.get('text')
        if not path:
            return {'ok': False, 'error': '存档键无效'}
        if not isinstance(text, str) or not text.startswith('{'):
            return {'ok': False, 'error': '存档内容无效'}
        try:
            write_atomic(path, text.encode('utf-8'), copy=request.get('backup') is True)
            return {'ok': True}
        except OSError as e:
            return {'ok': False, 'error': str(e)}
    if op == 'read':
        path = _path(request.get('key'))
        if not path:
            return {'ok': True, 'text': None}
        copy = path + COPY_SUFFIX
        if os.path.exists(copy):
            try:
                saved = _read_text(copy)
                if intact(saved):
                    return {'ok': True, 'text': saved}
            except OSError:
                pass
        try:
            return {'ok': True, 'text': _read_text(path)}
        except FileNotFoundError:
            return {'ok': True, 'text': None}
        except OSError as e:
            return {'ok': False, 'error': str(e)}
    if op == 'del':
        for key in request.get('keys') or []:
            path = _path(key)
            if not path:
                continue
            for target in (path, path + COPY_SUFFIX):
                try:
                    os.remove(target)
                except FileNotFoundError:
                    pass
                except OSError as e:
                    return {'ok': False, 'error': str(e)}
        return {'ok': True}
    if op == 'usage':
        total = 0
        try:
            for entry in os.scandir(_state['dataDir']):
                if entry.is_file():
                    try:
                        total += entry.stat().st_size
                    except OSError:
                        continue
        except OSError:
            pass
        return {'ok': True, 'bytes': total}
    if op == 'rebuild':
        return rebuild_index()
    if op == 'cacheGet':
        return cache_get(request.get('key'))
    if op == 'cachePut':
        return cache_put(request.get('key'), request.get('meta'), request.get('blob'))
    if op == 'cacheList':
        return cache_list()
    if op == 'cacheDrop':
        return cache_drop(request.get('keys'))
    if op == 'cacheTouch':
        return cache_touch(request.get('key'))
    return {'ok': False, 'error': '未知存储请求：' + op}


def _pick_dir():
    parent = os.path.dirname(_state['dataDir'])
    return parent if os.path.isdir(parent) else _state['dataDir']


def _file_types():
    return ('存档文件 (*.json;*.cmsave)', '所有文件 (*.*)')


def _dialog(name):
    try:
        from webview import FileDialog
        return getattr(FileDialog, name)
    except Exception:
        import webview
        return getattr(webview, name + '_DIALOG')()


def export_request(request):
    text = request.get('text')
    name = safe_name(request.get('name')) or '存档.json'
    if not isinstance(text, str):
        return {'ok': False, 'path': '', 'error': '导出内容无效'}
    window = _state['window']
    if window is None:
        return {'ok': False, 'path': '', 'error': '窗口未就绪'}
    if request.get('binary'):
        try:
            data = base64.b64decode(text)
        except Exception:
            return {'ok': False, 'path': '', 'error': '导出内容无效'}
    else:
        data = text.encode('utf-8')
    try:
        result = window.create_file_dialog(_dialog('SAVE'), directory=_pick_dir(),
                                           save_filename=name, file_types=_file_types())
        path = result if isinstance(result, str) else (result[0] if result else None)
        if not path:
            return {'ok': False, 'path': '', 'cancelled': True}
        write_atomic(path, data)
        return {'ok': True, 'path': path}
    except Exception as e:
        return {'ok': False, 'path': '', 'error': str(e)}


def import_request():
    window = _state['window']
    if window is None:
        return {'ok': False, 'path': '', 'error': '窗口未就绪'}
    try:
        result = window.create_file_dialog(_dialog('OPEN'), directory=_pick_dir(),
                                           allow_multiple=False, file_types=_file_types())
        path = result[0] if isinstance(result, (list, tuple)) and result else (
            result if isinstance(result, str) else None)
        if not path:
            return {'ok': False, 'path': '', 'cancelled': True}
        if os.path.getsize(path) > MAX_IMPORT:
            return {'ok': False, 'path': path, 'error': '文件过大，不是有效的存档'}
        with open(path, 'r', encoding='utf-8-sig') as f:
            return {'ok': True, 'path': path, 'text': f.read()}
    except Exception as e:
        return {'ok': False, 'path': '', 'error': str(e)}


def close_window(window):
    """销毁窗口，并兜住几条会让人以为「按钮没反应」的死路。

    pywebview 的 destroy 带 _shown_call：窗口还没真正显示时会一直等 shown 事件；
    destroy_window 在部分后端上要回调 GUI 线程，卡住时线程就永远不返回。
    到点还没关掉就不再依赖界面，直接结束进程。
    """
    guard = threading.Timer(FORCE_EXIT, _force_exit)
    guard.daemon = True
    guard.start()
    try:
        window.destroy()
    except Exception:
        _force_exit()


def _force_exit():
    os._exit(0)


def window_request(request):
    window = _state['window']
    if window is None:
        return False
    action = str(request.get('action') or '')
    if action == 'close':
        if request.get('allow') is not True:
            return False
        threading.Thread(target=close_window, args=(window,), daemon=True).start()
        return True
    if action == 'minimize':
        window.minimize()
    elif action == 'toggleMaximize':
        if request.get('fullscreen'):
            window.toggle_fullscreen()
        elif request.get('restore'):
            window.restore()
        else:
            window.maximize()
    elif action == 'restore':
        window.restore()
    else:
        return False
    return True
