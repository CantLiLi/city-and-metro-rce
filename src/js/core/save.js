'use strict';
// 本地存档（无账号）：浏览器中存档数据保存在 IndexedDB（容量大），不可用时退回 localStorage；
// 存档索引保存在 localStorage。桌面版由页面宿主（见 js/core/desk.js）直接读写本地文件。
// 支持多进度、自动/手动存档、文件导入导出（格式、版本、校验和检查）。
(function (CM) {
  const U = CM.U, CFG = CM.CFG;
  const P = CFG.saves.prefix;
  const IDX = P + 'index';
  // 宿主的 window.pywebview 通常晚于本脚本注入，所以桌面版判定要在用到时再问，不能在这里定死。
  // 宿主对象还没建好时，桌面标志本身也足以判定：这时只是接口暂时不可用，不该退回浏览器存储。
  const DESK = function () { return (window.CM && CM.DESKTOP && (window.__CM_DESKTOP_ || window.pywebview)) ? CM.DESKTOP : null; };
  // 已确认在桌面外壳里（用于「能不能存」这类必须同步回答的问题）
  const ON_DESK = function () { return DESK() !== null; };
  // 桌面宿主通过异步接口读写文件，因此索引改为内存副本 + 异步写入；
  // 同步 API（列表、改名等）仍读内存，跨会话的一致性由 Save.init 的预载保证。
  let memIndex = null, indexPending = 0, indexFlush = Promise.resolve();

  // ---------------- 存储后端 ----------------
  // 桌面版：每个存档是一个独立文件，键名直接作为文件名；索引另存为 index.json。
  const desk = {
    call: function (body) { return DESK().call('store', body); },
    put: function (key, str) {
      return desk.call({ op: 'save', key: key, text: str, backup: true }).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || '写入存档文件失败');
        return 'file';
      });
    },
    get: function (key) {
      return desk.call({ op: 'read', key: key }).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || '读取存档文件失败');
        return r.text == null ? null : r.text;
      });
    },
    del: function (key) {
      return desk.call({ op: 'del', keys: [key] }).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || '删除存档文件失败');
      });
    },
    indexInit: function () {
      return desk.call({ op: 'index' }).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || '读取存档索引失败');
        return r.text;
      });
    },
    indexPut: function (text) {
      return desk.call({ op: 'indexSave', text: text }).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || '写入存档索引失败');
      });
    },
    rebuildIndex: function () {
      return desk.call({ op: 'rebuild' }).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || '重建存档索引失败');
        return r;
      });
    },
  };

  let db = null, dbFailed = false, opening = null;
  function openDB() {
    if (db || dbFailed) return Promise.resolve(db);
    if(opening)return opening;
    opening = new Promise(function (resolve) {
      let settled=false;
      const fail=function(){if(settled)return;settled=true;dbFailed=true;resolve(null);};
      let req;
      try { req = indexedDB.open('city-metro', 1); } catch (e) { fail(); return; }
      req.onupgradeneeded = function () { if(!req.result.objectStoreNames.contains('slots'))req.result.createObjectStore('slots'); };
      req.onsuccess = function () {
        if(settled){req.result.close();return;}
        settled=true;db=req.result;const opened=db;
        opened.onversionchange=function(){opened.close();if(db===opened){db=null;dbFailed=false;}};
        resolve(db);
      };
      req.onerror = req.onblocked = fail;
    }).finally(function(){opening=null;});
    return opening;
  }
  function idbOp(mode, fn) {
    return openDB().then(function (d) {
      if (!d) throw new Error('IndexedDB 不可用');
      return new Promise(function (resolve, reject) {
        const tx = d.transaction('slots', mode);
        const st = tx.objectStore('slots');
        let result;
        const r = fn(st);
        if (r) r.onsuccess = function () { result = r.result; };
        tx.oncomplete = function () { resolve(result); };
        tx.onerror = function () { reject(tx.error || new Error('IndexedDB 写入失败')); };
        tx.onabort = function () { reject(tx.error || new Error('IndexedDB 事务中止')); };
      });
    });
  }
  const store = {
    put: function (key, str) {
      if (DESK()) return desk.put(key, str);
      return idbOp('readwrite', function (st) { return st.put(str, key); }).then(function () { return 'idb'; })
        .catch(function (e) { if (db) throw e; localStorage.setItem(key, str); return 'ls'; });
    },
    get: function (key, where) {
      if (DESK()) return desk.get(key);
      if (where === 'ls') return Promise.resolve(localStorage.getItem(key));
      return idbOp('readonly', function (st) { return st.get(key); })
        .then(function (v) { return v != null ? v : localStorage.getItem(key); }, function () { return localStorage.getItem(key); });
    },
    del: function (key, where) {
      if (DESK()) return desk.del(key);
      try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
      if (where === 'ls') return Promise.resolve();
      return idbOp('readwrite', function (st) { return st.delete(key); }).catch(function () { /* ignore */ });
    },
  };

  function emptyIndex() { return { games: {}, slots: {} }; }
  function checkIndex(o) {
    const object = function (v) { return v && typeof v === 'object' && !Array.isArray(v); };
    if (!object(o) || !object(o.games) || !object(o.slots) || !Object.values(o.games).every(object) || !Object.values(o.slots).every(object)) throw new Error('存档索引格式无效');
    return o;
  }
  // 清单只加载一次，失败原因留着：桌面接口晚到或磁盘暂时读不到时，靠它给用户说清到底怎么了。
  let indexError = '', indexLoad = null;
  function parseIndexText(text) {
    const info = { index: null, unreadable: [] };
    if (text) { try { info.index = checkIndex(JSON.parse(text)); } catch (e) { info.unreadable.push('index.json'); } }
    return info;
  }
  function pause(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function loadIndexOnce() {
    if (memIndex && !memIndex.broken) return Promise.resolve(memIndex);
    if (indexLoad) return indexLoad;
    const d = DESK();
    if (!d) return Promise.resolve(null);
    indexLoad = d.ready().then(function () {
      return desk.indexInit();
    }).then(function (text) {
      const info = parseIndexText(text);
      // 清单坏了要记住原因，但不能当成空清单继续覆盖写
      if (!info.index) {
        memIndex = info.unreadable.length
          ? { games: {}, slots: {}, broken: '存档索引（index.json）已损坏，为避免覆盖原有记录，本次不改写存档列表；可用「修复存档索引」按存档文件重新登记' }
          : emptyIndex();
      } else {
        memIndex = info.index;
      }
      indexError = '';
      return memIndex;
    });
    indexLoad = indexLoad.then(function (r) { indexLoad = null; return r; }, function (e) { indexLoad = null; indexError = errMsg(e); throw e; });
    return indexLoad;
  }
  // 任何写操作前都先确保清单在内存里：init 失败（宿主接口迟到、目录一时读不到）不该让存档功能一直瘫着。
  function ensureIndex() {
    if (!DESK()) return Promise.resolve(memIndex);
    // 上次失败留下的占位清单要给它重试机会：宿主接口迟到时，失败不代表存档目录真的坏了。
    if (memIndex && !memIndex.broken) return Promise.resolve(memIndex);
    const attempt = function (left) {
      return loadIndexOnce().catch(function (e) {
        if (left <= 0) throw e;
        return pause(150).then(function () { return attempt(left - 1); });
      });
    };
    return attempt(6);
  }
  function readIndex(strict) {
    if (DESK()) {
      if (!memIndex) {
        if (!strict) return emptyIndex();
        throw new Error(indexError ? '存档列表未能载入（' + indexError + '）' : '存档索引尚未载入，请稍候再试');
      }
      // 清单读坏了却当成空清单继续写，会把玩家的存档列表抹掉：这里一律停写。
      if (memIndex.broken && strict) throw new Error(memIndex.broken);
      return memIndex;
    }
    try {
      const s = localStorage.getItem(IDX);
      if (!s) return emptyIndex();
      return checkIndex(JSON.parse(s));
    } catch (e) { if(strict)throw new Error('存档索引无法读取，已停止改写并保留原数据；请先导出当前进度作为备份。');return emptyIndex(); }
  }
  function writeIndex(idx) {
    if (!DESK()) { localStorage.setItem(IDX, JSON.stringify(idx)); return; }
    memIndex = idx;
    const text = JSON.stringify(idx);
    // 上一次索引写入失败不能把这条链焊死：吞掉旧错误后照常写这一次，失败由 settle() 报给调用方。
    indexFlush = indexFlush.catch(function () {}).then(function () { return desk.indexPut(text); });
    indexPending++;
    indexFlush.then(function () { indexPending--; }, function () { indexPending--; });
  }
  // 桌面版索引写入是异步的：把索引当作已提交结果返回之前先等它落盘
  function settle() {
    if (!DESK()) return Promise.resolve();
    return indexFlush.then(function () {}, function () { throw new Error('存档索引写入失败（检查存档目录是否可写）'); });
  }
  function errMsg(e) {
    if (!e) return '未知错误';
    if (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014) return '磁盘空间不足（可删除旧存档或导出备份后清理）';
    if (e.name === 'SecurityError') return '无法访问存档目录（检查磁盘权限或安全软件）';
    return e.message || String(e);
  }

  const Save = {};
  let writeTail = Promise.resolve(), writeSeq = 0, lastSavedAt = 0;
  // 只跟踪仍在排队的保存，操作完成即释放；删除 / 改名先于数据写入开始时同样有效。
  const pendingWrites = new Set();
  function queueWrite(work) {
    const next = writeTail.then(work);
    writeTail = next.then(function () {}, function () {});
    return next;
  }
  function uniqueWriteId() { return U.uid('') + '-' + (++writeSeq).toString(36); }
  // 同一时钟刻度内也按写入顺序排序，确保自动轮换及「最近存档」正确。
  function savedAt(requested) { lastSavedAt = Math.max(Date.now(), requested || 0, lastSavedAt + 1); return lastSavedAt; }
  // 宿主的 window.pywebview 晚于页面脚本注入：init 可能先按浏览器版跑完，
  // 桌面标志一出现就补载清单，列表、导入、导出才能切到文件接口。
  function watchDesk() {
    let tries = 0;
    const tick = function () {
      if (DESK()) {
        if (memIndex && !memIndex.broken) return;
        loadIndexOnce().then(function () {
          if (!memIndex || memIndex.broken) return;
          const info = CM.Save.state || {};
          info.index = memIndex;
          info.store = 'file';
          info.dataDir = Save.dataDir();
          info.failed = '';
          CM.Save.state = info;
          try { window.dispatchEvent(new CustomEvent('cm-saves-ready')); } catch (e) { /* ignore */ }
        }, function () {});
        return;
      }
      if (++tries > 140) return;
      setTimeout(tick, 50);
    };
    window.addEventListener('pywebviewready', tick);
    setTimeout(tick, 60);
  }
  Save.init = function () {
    const d = DESK();
    if (!d) {
      watchDesk();
      return openDB();
    }
    // 接口可能比桌面标志晚到：等宿主就绪，超时也按桌面版继续，绝不退回浏览器存储
    return d.ready().then(function (boot) {
      return ensureIndex().then(function () { return boot; }, function (e) {
        // 清单读不到时先按存档文件重建（清单丢了不代表存档丢了），重建也失败才停下来并记住原因
        return Save.rebuildIndex().then(function () { return boot; }, function (e2) {
          indexError = errMsg(e) + '；' + errMsg(e2);
          memIndex = { games: {}, slots: {}, broken: '无法读取存档目录（' + indexError + '）' };
          return boot;
        });
      }).then(function (boot) {
        const broken = !!(memIndex && memIndex.broken);
        const info = { index: broken ? null : memIndex, repaired: [], recovered: [], unreadable: [], dataDir: d.dataDir, store: 'file' };
        if (broken) { info.failed = memIndex.broken; info.unreadable.push('index.json'); }
        if (boot && boot.storage) {
          const s = boot.storage;
          if (s.repaired) info.repaired = s.repaired;
          if (s.recovered) info.recovered = s.recovered;
          if (s.unreadable) info.unreadable = info.unreadable.concat(s.unreadable);
        }
        CM.Save.state = info;
        return 'file';
      });
    });
  };
  Save.backend = function () { return DESK() ? 'file' : (db ? 'IndexedDB' : 'localStorage'); };
  Save.isDesktop = function () { return ON_DESK(); };
  Save.backendLabel = function () { return DESK() ? '本地文件' : (db ? '浏览器数据库' : '浏览器本地存储'); };
  Save.dataDir = function () { const d = DESK(); return d ? d.dataDir : ''; };
  Save.storageNote = function () {
    const size = '全部存档约 ' + (Save.usage() / 1024 / 1024).toFixed(1) + ' MB。';
    if (DESK()) {
      return '游戏无需账号，进度以文件形式保存在此电脑的 ' + Save.dataDir() + ' 目录中，同目录的 index.json 记录存档列表。开启自动保存后，每月及建设完成时保存，在两个自动槽位间轮换。导出时由系统保存对话框选择位置；更换电脑可先导出再导入。' + size;
    }
    return '游戏无需账号，进度保存在当前浏览器、当前网址的站点数据（' + (db ? 'IndexedDB' : 'localStorage') + '）中，索引保存在 localStorage。开启自动保存后，每月及建设完成时保存，在两个自动槽位间轮换。导出文件的位置由浏览器下载设置或保存对话框决定。本地存档不跨网址、浏览器或设备同步；清除站点数据会删除存档，请提前导出备份，更换环境后再导入。' + size;
  };
  Save.flush = function () { return settle(); };
  // 按存档文件重新登记清单：清单损坏或文件被外面挪动过时的最后手段
  Save.rebuildIndex = function () {
    const d = DESK();
    if (!d || !d.rebuildIndex) return Promise.reject(new Error('当前环境不支持重建存档索引'));
    return d.rebuildIndex().then(function (r) {
      if (!r || !r.ok) throw new Error((r && r.error) || '重建存档索引失败');
      const idx = checkIndex(r.index);
      memIndex = idx;
      if (!CM.Save.state) CM.Save.state = {};
      CM.Save.state.index = idx;
      CM.Save.state.failed = '';
      return idx;
    });
  };
  Save.available = function () {
    // 桌面版把存档写成文件：能保存与否不取决于清单有没有载入完，先载入中也不该报警。
    if (ON_DESK()) return true;
    try { const k = P + '__t'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true; } catch (e) { return false; }
  };
  Save.envelope = function (game) {
    const body = JSON.stringify(game.serialize());
    return { format: CFG.SAVE_FORMAT, version: CFG.SAVE_VERSION, gameVersion: CFG.GAME_VERSION, savedAt: Date.now(), checksum: U.fnv(body), body: body };
  };
  // kind: 'auto' | 'manual'；opts: { slotId（覆盖）, label }。返回 Promise<{ok, error, slotId}>
  Save.save = function (game, kind, opts) {
    opts = Object.assign({}, opts);
    let env, trafficSnapshot, trafficKey;
    try { env = Save.envelope(game); } catch (e) { return Promise.resolve({ ok: false, error: '序列化失败：' + errMsg(e) }); }
    if (CM.TrafficCache) { trafficSnapshot = CM.TrafficCache.capture(game); if (trafficSnapshot) trafficKey = CM.TrafficCache.keyFor(env.body, env.checksum); }
    // 请求时即冻结快照及索引摘要；排队期间时间推进、切图或改名不改写本次快照。
    const snap = { id: game.id, name: game.name, mode: game.mode, map: game.mapId || 'gz', createdAt: game.createdAt,
      date: [game.clock.y, game.clock.m, game.clock.d], stations: game.compiled.stations.length, funds: game.econ.isFree() ? null : game.econ.funds };
    const pending = { gameId: snap.id, slotId: opts.slotId, cancelled: false, name: null };
    pendingWrites.add(pending);
    return ensureIndex().then(function () { return queueWrite(function () {
      if (pending.cancelled) return { ok: false, error: '该进度或存档已被删除，本次写入已取消' };
      const idx = readIndex(true); let slotId = opts.slotId;
      if (kind === 'auto') {
        const a1 = idx.slots[snap.id + '.a1'], a2 = idx.slots[snap.id + '.a2'];
        slotId = !a1 ? snap.id + '.a1' : (!a2 ? snap.id + '.a2' : (a1.savedAt <= a2.savedAt ? snap.id + '.a1' : snap.id + '.a2'));
      } else if (!slotId || !idx.slots[slotId]) {
        const manual = Object.values(idx.slots).filter(function (s) { return s.gameId === snap.id && s.kind === 'manual'; });
        if (manual.length >= CFG.saves.maxManual) return { ok: false, error: '该进度的手动存档已达上限（' + CFG.saves.maxManual + ' 个），请覆盖或删除旧存档' };
        slotId = snap.id + '.m' + uniqueWriteId();
      }
      const old = idx.slots[slotId];
      pending.slotId = slotId;
      if (old && old.gameId !== snap.id) return { ok: false, error: '不能覆盖其他进度的存档' };
      const key = P + 'slot.' + slotId + '.' + uniqueWriteId();
      env.savedAt = savedAt(env.savedAt); const str = JSON.stringify(env);
      const meta = { slotId: slotId, key: key, gameId: snap.id, kind: kind, label: opts.label || (kind === 'auto' ? '自动存档' : '手动存档'),
        date: snap.date, savedAt: env.savedAt, size: str.length, mode: snap.mode, name: snap.name, map: snap.map, stations: snap.stations, funds: snap.funds };
      // 写入串行化，使额度、轮换和覆盖均依据上一次已提交的索引；失败不覆盖旧数据。
      return store.put(key, str).then(function (where) {
        return store.get(key, where).then(function (back) {
          if (back !== str) { store.del(key, where); return { ok: false, error: '写入后校验失败' }; }
          let idx2; try { idx2 = readIndex(true); } catch (e) { store.del(key, where); throw e; }
          // 写入期间删除或改名，不能由迟到的保存回写旧索引。
          if (pending.cancelled || (idx.games[snap.id] && !idx2.games[snap.id]) || (old && !idx2.slots[slotId])) {
            store.del(key, where); return { ok: false, error: '该进度或存档已被删除，本次写入已取消' };
          }
          const name = pending.name !== null ? pending.name : (idx.games[snap.id] && idx2.games[snap.id] && idx.games[snap.id].name !== idx2.games[snap.id].name ? idx2.games[snap.id].name : snap.name);
          idx2.games[snap.id] = { gameId: snap.id, name: name, mode: snap.mode, map: snap.map, createdAt: snap.createdAt, updatedAt: env.savedAt };
          meta.name = name;
          meta.store = where; idx2.slots[slotId] = meta;
          try { writeIndex(idx2); }
          catch (e) { store.del(key, where); return { ok: false, error: errMsg(e) }; }
          if (old && old.key && old.key !== key) store.del(old.key, old.store);
          return settle().then(function () { return { ok: true, slotId: slotId, savedAt: env.savedAt, size: str.length }; });
        });
      });
    }); }).then(async function (result) {
      if (trafficSnapshot) { if (result.ok) CM.TrafficCache.put(await trafficKey, trafficSnapshot); else CM.TrafficCache.discard(trafficSnapshot); }
      return result;
    }).catch(function (e) { if (trafficSnapshot) CM.TrafficCache.discard(trafficSnapshot); return { ok: false, error: errMsg(e) }; }).finally(function () { pendingWrites.delete(pending); });
  };
  // mapId：只列出该地图的进度（不传则列出全部）
  Save.list = function (mapId) {
    const idx = readIndex();
    const grouped = new Map();
    for (const slot of Object.values(idx.slots)) { let a = grouped.get(slot.gameId); if (!a) grouped.set(slot.gameId, a = []); a.push(slot); }
    const games = Object.values(idx.games).filter(function (g) { return !mapId || (g.map || 'gz') === mapId; }).map(function (g) {
      const slots = (grouped.get(g.gameId) || []).sort(function (a, b) { return b.savedAt - a.savedAt; });
      return Object.assign({}, g, { slots: slots, latest: slots[0] ? slots[0].savedAt : 0 });
    }).filter(function (g) { return g.slots.length; });
    games.sort(function (a, b) { return b.latest - a.latest; });
    return games;
  };
  Save.latest = function (mapId) {
    const g = Save.list(mapId)[0];
    return g ? g.slots[0] : null;
  };
  Save.slotInfo = function (slotId) {
    return readIndex().slots[slotId] || null;
  };
  Save.parseEnvelope = function (text) {
    let env;
    try { env = JSON.parse(text); } catch (e) { throw new Error('文件不是有效的存档（JSON 解析失败）'); }
    if (!env || env.format !== CFG.SAVE_FORMAT) throw new Error('文件格式不正确：不是《城市与地铁》存档');
    if (typeof env.version !== 'number' || env.version > CFG.SAVE_VERSION) throw new Error('存档版本（' + env.version + '）高于当前游戏支持的版本（' + CFG.SAVE_VERSION + '），无法导入');
    if (env.version < CFG.SAVE_MIN_VERSION) throw new Error('该存档来自 1.0 版（旧示意地图）。1.1 版起改用真实的广州地理，旧存档的城市数据无法对应，请开始新游戏。');
    if (typeof env.body !== 'string' || U.fnv(env.body) !== env.checksum) throw new Error('存档校验失败：文件可能已损坏或被修改');
    let payload;
    try { payload = JSON.parse(env.body); } catch (e) { throw new Error('存档内容损坏'); }
    if (payload && payload.rulesRevision != null && (!Number.isSafeInteger(payload.rulesRevision) || payload.rulesRevision < 0 || payload.rulesRevision > (CFG.RULES_REVISION || 0))) throw new Error('存档使用了当前游戏尚不支持的经营与建设规则，请使用对应版本载入');
    const ok = payload && payload.meta && payload.clock && payload.city && payload.net && payload.econ && payload.tasks;
    if (!ok) throw new Error('存档缺少必要数据');
    // 存档所属地图（1.4 版之前的存档都是广州）：按该地图的网格尺寸校验
    const mp = CM.MAPS && CM.MAPS[payload.meta.map || 'gz'];
    if (!mp) throw new Error('存档使用的地图「' + payload.meta.map + '」在当前版本中不存在');
    // 地图数据版本：缺省为 1（1.4 版及更早的广州 / 青湾存档）。存档版本高于当前地图数据时拒绝载入；
    // 低于当前版本时按地图登记的迁移函数处理（迁移只作用于解析出的副本，失败时原存档不受影响）
    const mv = payload.meta.mapVersion || 1;
    if (mv > mp.mapVersion) throw new Error('存档使用的「' + mp.name + '」地图数据为第 ' + mv + ' 版，当前游戏使用第 ' + mp.mapVersion + ' 版，暂不兼容。请使用支持第 ' + mv + ' 版地图的游戏载入，或导出原存档进行兼容检查；刷新当前游戏不能保证解决。');
    if (mv < (mp.minVersion || 1)) throw new Error('存档的「' + mp.name + '」地图数据版本（第 ' + mv + ' 版）过旧，当前版本无法兼容');
    if (mv < mp.mapVersion) {
      if (!mp.migrate) throw new Error('「' + mp.name + '」地图数据已从第 ' + mv + ' 版更新到第 ' + mp.mapVersion + ' 版，且没有可用的迁移方法');
      try { mp.migrate(payload, mv); payload.meta.mapVersion = mp.mapVersion; } catch (e) { throw new Error('存档迁移失败（' + (e && e.message || e) + '），原存档未改动'); }
      payload.__mapMigratedFrom = mv;   // 载入时先为原存档建立「升级前备份」（见 Save.load）
    }
    for (const k of ['pop', 'jobs', 'bh', 'taken', 'lu', 'street', 'urbanYear']) {
      const a = payload.city[k];
      if (!a || !a.b || a.n !== mp.cfg.W * mp.cfg.H) throw new Error('城市数据不完整或尺寸不符');
    }
    return { env: env, payload: payload };
  };
  function readSlotText(slotId) {
    return ensureIndex().then(function () {
      const meta = readIndex().slots[slotId];
      if (!meta) return Promise.reject(new Error('存档不存在'));
      return store.get(meta.key, meta.store).then(function (text) {
        if (!text) throw new Error('存档数据丢失（存档文件可能已被移走或删除）');
        return { meta: meta, text: text };
      });
    });
  }
  // 进度重命名保存在索引中，不重写每个历史快照；读取与导出时将最新名称应用到副本。
  // 改名前先在 env 上留下原始校验和：交通缓存以存档文件的原文校验和为键（见 TrafficCache.keyFor），
  // 直接拿改名重算后的校验和会把重命名过的存档的缓存全部对不上，每次读档都要重新求解全部时段。
  function parseSlot(r) {
    const parsed = Save.parseEnvelope(r.text);
    parsed.rawChecksum = parsed.env.checksum;
    if (typeof r.meta.name === 'string' && parsed.payload.meta.name !== r.meta.name) {
      parsed.payload.meta.name = r.meta.name;
      parsed.env.body = JSON.stringify(parsed.payload);
      parsed.env.checksum = U.fnv(parsed.env.body);
    }
    return parsed;
  }
  // 载入：旧交通模型的存档（v1.8 及更早）或旧地图版本的存档（地图范围扩展前）在升级前先把原始存档另存为「升级前备份」
  // （只建一次，不计入手动存档上限），备份失败时仍可载入，但不自动保存升级后的进度（见 main.js），原存档不受影响
  Save.load = function (slotId) {
    return readSlotText(slotId).then(function (r) {
      const parsed = parseSlot(r), p = parsed.payload;
      const tv = (p.traffic && p.traffic.v) || 1;
      const mp = CM.MAPS[p.meta.map || 'gz'];
      const terrainUpgrade = (p.city.terrainRevision || 1) < (mp.data.terrainRevision || 1);
      const displayUpgrade = (p.city.displayRevision || 1) < (mp.data.displayRevision || 1);
      const rulesUpgrade = (p.rulesRevision || 0) < (CFG.RULES_REVISION || 0);
      if (tv >= (CFG.TRAFFIC_MODEL || 1) && !rulesUpgrade && !p.__mapMigratedFrom && !terrainUpgrade && !displayUpgrade) {
        if (!CM.TrafficCache) return p;
        return CM.TrafficCache.keyFor(parsed.env.body, parsed.rawChecksum).then(async function (key) {
          Object.defineProperty(p, '__trafficKey', { value: key });
          Object.defineProperty(p, '__trafficState', { value: await CM.TrafficCache.get(key) });
          return p;
        });
      }
      if (r.meta.kind === 'backup') return p;
      // 已解析过的信封直接复用（改名过的存档 body 已被重写过，那份按原文件重新解析，避免备份比对口径不一致）
      return Save.backupBeforeUpgrade(r, p, parsed.rawChecksum === parsed.env.checksum ? parsed.env : null).then(function (res) {
        if (res.ok) p.__backupSlot = res.slotId; else p.__backupFailed = res.error || '未知错误';
        return p;
      });
    });
  };
  Save.backupBeforeUpgrade = function (r, payload, env0) {
    let env = env0 || null; if (!env) { try { env = Save.parseEnvelope(r.text).env; } catch (e) { return Promise.resolve({ ok: false, error: '原存档校验失败：' + errMsg(e) }); } }
    const meta = r.meta, from = (payload.meta && payload.meta.gameVersion) || env.gameVersion || '1.8.0';
    const slotId = meta.gameId + '.bk' + String(env.savedAt || meta.savedAt || 0);
    return queueWrite(async function () {
      const idx = readIndex(true);
      const old = idx.slots[slotId];
      if (old && old.kind === 'backup' && old.gameId === meta.gameId && old.key !== meta.key) {
        try {
          const cached = Save.parseEnvelope(await store.get(old.key, old.store));
          // 索引存在不代表备份有效；确认格式、校验和及原始快照一致后，才允许跳过备份。
          if (cached.env.body === env.body) return { ok: true, slotId: slotId, existed: true };
        } catch (e) { /* 损坏或丢失的备份从已校验的原存档重建 */ }
      }
      const key = P + 'slot.' + slotId + '.' + uniqueWriteId(), text = r.text;
      return store.put(key, text).then(function (where) {
        return store.get(key, where).then(function (back) {
          if (back !== text) { store.del(key, where); return { ok: false, error: '备份写入后校验失败' }; }
          let idx2; try { idx2 = readIndex(true); } catch (e) { store.del(key, where); throw e; }
          if (!idx2.games[meta.gameId] || !idx2.slots[meta.slotId]) { store.del(key, where); return { ok: false, error: '原存档已被删除，备份已取消' }; }
          idx2.slots[slotId] = Object.assign({}, meta, { slotId: slotId, key: key, store: where, kind: 'backup', label: '升级前备份（v' + from + '）', savedAt: meta.savedAt, size: text.length });
          if (!idx2.games[meta.gameId]) idx2.games[meta.gameId] = { gameId: meta.gameId, name: meta.name, mode: meta.mode, map: meta.map, createdAt: payload.meta.createdAt, updatedAt: meta.savedAt };
          try { writeIndex(idx2); } catch (e) { store.del(key, where); return { ok: false, error: errMsg(e) }; }
          // 新副本及索引提交后才清理旧备份；不删除原档或其他槽仍引用的数据。
          if (old && old.kind === 'backup' && old.gameId === meta.gameId && old.key !== meta.key && old.key !== key && !Object.values(idx2.slots).some(function (s) { return s.key === old.key; })) store.del(old.key, old.store);
          return settle().then(function () { return { ok: true, slotId: slotId, repaired: !!old }; });
        });
      });
    }).catch(function (e) { return { ok: false, error: errMsg(e) }; });
  };
  Save.remove = function (slotId) {
    const idx = readIndex(true);
    const meta = idx.slots[slotId];
    if (!meta) return;
    delete idx.slots[slotId];
    if (!Object.values(idx.slots).some(function (s) { return s.gameId === meta.gameId; })) delete idx.games[meta.gameId];
    writeIndex(idx);
    for (const pending of pendingWrites) if (pending.slotId === slotId || (!idx.games[meta.gameId] && pending.gameId === meta.gameId)) pending.cancelled = true;
    store.del(meta.key, meta.store);
  };
  Save.removeGame = function (gameId) {
    const idx = readIndex(true), removed=[];
    for (const s of Object.values(idx.slots)) if (s.gameId === gameId) { delete idx.slots[s.slotId]; removed.push(s); }
    delete idx.games[gameId];
    writeIndex(idx);
    for (const pending of pendingWrites) if (pending.gameId === gameId) pending.cancelled = true;
    for(const s of removed)store.del(s.key,s.store);
  };
  Save.rename = function (gameId, name) {
    const idx = readIndex(true);
    if (!idx.games[gameId]) return;
    idx.games[gameId].name = name;
    for (const s of Object.values(idx.slots)) if (s.gameId === gameId) s.name = name;
    writeIndex(idx);
    for (const pending of pendingWrites) if (pending.gameId === gameId) pending.name = name;
  };
  Save.fileName = function (meta) {
    const d = meta.date || [0, 0];
    return '城市与地铁_' + (meta.name || '存档').replace(/[\\/:*?"<>|]/g, '_') + '_' + d[0] + '年' + d[1] + '月.cmsave.json';
  };
  // 桌面版写入的是本地文件：文件名即存档键，导出时由宿主弹出保存对话框
  Save.download = function (text, filename) {
    const fail = function () { CM.U && CM.U.toast && CM.U.toast('导出失败：无法保存文件'); };
    const d = DESK();
    if (d && d.exportFile) {
      return d.exportFile(text, filename).then(function (r) {
        if (r && r.ok) return true;
        if (r && r.cancelled) return false;
        fail();
        return false;
      }, fail);
    }
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
    return Promise.resolve(true);
  };
  Save.exportSlot = function (slotId) {
    return readSlotText(slotId).then(function (r) {
      let text = r.text, raw = false;
      // 导出是救援入口：地图 / 格式不兼容或校验失败时仍能取出原始文本，不迁移、不改写存储。
      // 可正常读取的存档沿用最新进度名称；其他存档逐字导出，不表示其已经可载入。
      try { text = JSON.stringify(parseSlot(r).env); } catch (e) { raw = true; }
      return Save.download(text, Save.fileName(r.meta)).then(function (ok) { return { raw: raw, saved: ok }; });
    });
  };
  Save.exportGame = function (game) {
    const env = Save.envelope(game);
    return Save.download(JSON.stringify(env), Save.fileName({ name: game.name, date: [game.clock.y, game.clock.m] }));
  };
  // 导入：校验通过后作为新的手动存档保存，不覆盖已有进度。返回 Promise
  Save.importText = function (text) {
    let r;
    try { r = Save.parseEnvelope(text); } catch (e) { return Promise.reject(e); }
    return ensureIndex().then(function () { return queueWrite(function () {
      const idx = readIndex(true);
      const p = r.payload;
      delete p.__mapMigratedFrom;   // 导入即为新副本（原文件仍在玩家手中），不再另建升级前备份；迁移结果随副本保存
      if (p.mapUpgrade) p.mapUpgrade.imported = true;
      let gameId = p.meta.gameId, name = p.meta.name;
      if (idx.games[gameId]) { gameId = U.uid('g'); name = name + '（导入）'; p.meta.gameId = gameId; p.meta.name = name; }
      const body = JSON.stringify(p);
      const env = { format: CFG.SAVE_FORMAT, version: CFG.SAVE_VERSION, gameVersion: CFG.GAME_VERSION, savedAt: savedAt(), checksum: U.fnv(body), body: body };
      const str = JSON.stringify(env);
      const slotId = gameId + '.m' + uniqueWriteId();
      const key = P + 'slot.' + slotId + '.' + uniqueWriteId();
      return store.put(key, str).then(function (where) {
        let idx2; try { idx2 = readIndex(true); } catch (e) { store.del(key, where); throw e; }
        idx2.games[gameId] = { gameId: gameId, name: name, mode: p.meta.mode, map: p.meta.map || 'gz', createdAt: p.meta.createdAt, updatedAt: env.savedAt };
        idx2.slots[slotId] = { slotId: slotId, key: key, store: where, gameId: gameId, kind: 'manual', label: '导入的存档', date: [p.clock.y, p.clock.m, p.clock.d], savedAt: env.savedAt, size: str.length, mode: p.meta.mode, map: p.meta.map || 'gz', name: name, stations: Object.keys(p.net.stations || {}).length, funds: p.econ.mode === 'free' ? null : p.econ.funds };
        try { writeIndex(idx2); } catch (e) { store.del(key, where); throw new Error(errMsg(e)); }
        return settle().then(function () { return { slotId: slotId, gameId: gameId, name: name, map: p.meta.map || 'gz' }; });
      }, function (e) { throw new Error(errMsg(e)); });
    }); });
  };
  Save.usage = function () {
    let n = 0;
    for (const s of Object.values(readIndex().slots)) n += s.size || 0;
    return n;
  };
  // 桌面版：直接选取本地存档文件导入（浏览器版由页面的 <input type=file> 提供）
  Save.pickImport = function () {
    const d = DESK();
    if (!d || !d.importFile) return Promise.resolve(null);
    return d.importFile().then(function (r) {
      if (r && r.ok && typeof r.text === 'string') return { text: r.text, name: r.path };
      if (r && r.error) throw new Error(r.error);
      return null;
    });
  };
  // 未保存进度可能因为关闭、崩溃或断电丢失：页面把当前进度压成快照交给宿主留底，下次启动时可再取回。
  Save.crashSave = function (game) {
    const d = DESK();
    if (!d || !d.snapshot) return Promise.resolve(false);
    let text;
    try { text = JSON.stringify(Save.envelope(game)); } catch (e) { return Promise.resolve(false); }
    return d.snapshot({ gameId: game.id, name: game.name, map: game.mapId || 'gz', text: text });
  };
  Save.recoverList = function () {
    const d = DESK();
    if (!d || !d.ready) return Promise.resolve([]);
    return d.ready().then(function (boot) { return (boot && boot.recovered) || []; });
  };
  Save.recoverLoad = function (name) {
    const d = DESK();
    if (!d || !d.recoverRead) return Promise.reject(new Error('当前环境不支持恢复'));
    return d.recoverRead(name).then(function (r) {
      if (!r || typeof r.text !== 'string') throw new Error('恢复文件已不存在');
      return { text: r.text };
    });
  };
  Save.recoverDrop = function (name) {
    const d = DESK();
    if (!d || !d.recoverDrop) return Promise.resolve();
    return d.recoverDrop(name).then(function () {}, function () {});
  };
  CM.Save = Save;
})(window.CM);
