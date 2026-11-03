'use strict';
// Optional, bounded browser cache. Game saves remain complete and independent.
(function(CM){
  const compact=(navigator.deviceMemory&&navigator.deviceMemory<=4)||matchMedia('(pointer:coarse)').matches;
  // 保留最近若干个存档的快照：自动存档是 a1 / a2 轮换，不需要更多。
  // 单份快照含 8 个时段的全部统计数组（含 1080×1080 的汽车最短路矩阵），广州约 76MB，
  // 上限必须容得下它，否则 capture 永远返回 null —— 交通缓存一条也存不进去，每次读档都要重算全部时段。
  const MAX_ENTRY=(compact?88:128)*1024*1024,MAX_TOTAL=(compact?100:192)*1024*1024,MAX_COUNT=2;
  const scalars=['dt','stats','iters','solveSteps','quiet','stable','demandTotal','error','facKey','reviewLimit'];
  let dbPromise,currentDb,chain=Promise.resolve(),leasedBytes=0;const pending=new Map(),verified=new WeakSet(),leases=new WeakMap();
  const clone=x=>JSON.parse(JSON.stringify(x));
  // 桌面版存档落在文件里，IndexedDB 却跟着 WebView 进程一起消失：快照必须写进宿主数据目录才能跨启动复用。
  // 判断交给 desk.js 的 desktop()：它同时认 api 就绪和 __CM_DESKTOP_ / pywebview 两个标记，
  // 这里自己看着两个标记会比脚本加载还早，把桌面版误判成浏览器分支。
  const desk=()=>CM.desktop&&CM.desktop()&&CM.DESKTOP&&typeof CM.DESKTOP.call==='function'?CM.DESKTOP:null;
  // 桌面版把它直接当文件名，冒号在 Windows 上不可用；分隔符必须与后端无关地固定下来，
  // 否则同一个存档在「存档时走浏览器分支、读档时走桌面分支」的两次运行里算出两个不同的键。
  const key=checksum=>CM.SIM_STAMP+'-'+checksum;
  function deskCall(op,body){
    const d=desk();if(!d)return Promise.resolve(null);
    return Promise.resolve(d.call(Object.assign({op},body||{}))).then(r=>{
      const res=typeof r==='string'?JSON.parse(r):r;
      if(!res||!res.ok)throw new Error((res&&res.error)||'交通缓存读写失败');
      return res;
    });
  }
  // 桌面版的文件后端：meta 里的 dataHash / metaHash 仍然校验，沙箱外的损坏读不进来。
  // 二进制走独立的一次调用，不塞进 JSON —— 76MB 的快照编成 base64 要多占三分之一，编解码本身也是几百毫秒。
  async function deskGet(k){
    const r=await deskCall('cacheGet',{key:k});
    if(!r||typeof r.meta!=='string'||!r.blob)return null;
    let meta;try{meta=JSON.parse(r.meta);}catch(e){return null;}
    const bytes=Uint8Array.from(atob(r.blob),c=>c.charCodeAt(0));
    return {meta,data:bytes.buffer};
  }
  async function deskPut(k,snapshot,dataHash,metaHash){
    const bytes=new Uint8Array(snapshot.data);
    // 分块越小拼接越快：一次 apply 的参数越多，引擎要为调用准备越大的参数表（76MB 上 0x1000 比 0x8000 快约四成）
    let text='';const CH=0x1000;
    for(let i=0;i<bytes.length;i+=CH)text+=String.fromCharCode.apply(null,bytes.subarray(i,i+CH));
    // metaHash 是对「不含 dataHash / metaHash 的原 meta + dataHash」算的，读取时要按同样口径复算
    await deskCall('cachePut',{key:k,meta:JSON.stringify(Object.assign({},snapshot.meta,{dataHash,metaHash})),blob:btoa(text)});
  }
  async function deskTrim(){
    const r=await deskCall('cacheList',{});
    const rows=(r&&r.list)||[];
    let bytes=rows.reduce((n,row)=>n+row.bytes,0),count=rows.length;
    if(bytes<=MAX_TOTAL&&count<=MAX_COUNT)return;
    const drop=[];
    for(const row of rows){
      if(bytes<=MAX_TOTAL&&count<=MAX_COUNT)break;
      drop.push(row.key);bytes-=row.bytes;count--;
    }
    if(drop.length)await deskCall('cacheDrop',{keys:drop});
  }
  function touch(k){
    const d=desk();if(!d)return;
    deskCall('cacheTouch',{key:k}).catch(()=>{});
  }
  function closeDb(db){
    try{db.close();}catch(e){/* Already closed. */}
    if(currentDb===db){currentDb=null;dbPromise=null;}
  }
  function open(){
    if(!dbPromise){
      const promise=new Promise(resolve=>{
        let done=false;
        const finish=db=>{if(done){if(db)db.close();return;}done=true;clearTimeout(timer);if(db)currentDb=db;resolve(db);};
        const timer=setTimeout(()=>finish(null),1500);let request;
        try{request=indexedDB.open('city-metro-web-traffic',1);}catch(e){finish(null);return;}
        request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains('entries'))db.createObjectStore('entries');if(!db.objectStoreNames.contains('lru')){const store=db.createObjectStore('lru',{keyPath:'key'});store.createIndex('used','used');}};
        request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>closeDb(db);finish(db);};
        request.onerror=request.onblocked=()=>finish(null);
      });
      dbPromise=promise;
      promise.then(db=>{if(!db&&dbPromise===promise)dbPromise=null;});
    }
    return dbPromise;
  }
  // This database is optional. A stalled transaction must not stall loading,
  // cache leases or the next queued cache write indefinitely.
  function transaction(db,stores,mode,work,timeout=1500){
    return new Promise((resolve,reject)=>{
      let tx,value,done=false;
      const finish=error=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(typeof value==='function'?value():value);};
      const timer=setTimeout(()=>{const error=new Error('交通缓存事务超时');try{if(tx)tx.abort();}catch(e){/* May already have ended. */}finish(error);closeDb(db);},timeout);
      try{
        tx=db.transaction(stores,mode);
        tx.oncomplete=()=>finish();tx.onerror=tx.onabort=()=>finish(tx.error||new Error('交通缓存事务中止'));
        value=work(tx);
      }catch(e){try{if(tx)tx.abort();}catch(abortError){/* Already closed. */}finish(e);}
    });
  }
  async function digest(data){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data))).map(v=>v.toString(16).padStart(2,'0')).join('');}
  // 存档时手里已有 body 的 FNV 校验和，等于省掉一次对几 MB 文本的 SHA-256 编码与摘要（读档、写档各一次）
  async function keyFor(body,checksum){if(checksum)return checksum;try{return await digest(new TextEncoder().encode(body));}catch(e){return null;}}
  const metaDigest=(meta,dataHash)=>digest(new TextEncoder().encode(JSON.stringify(meta)+':'+dataHash));
  const roadGuards=new WeakMap(),metroGuards=new WeakMap();
  const arrayGuards=arrays=>arrays.map(a=>CM.U.fnv(Array.from(a).join(',')));
  // 快照只对自己「计算过」的那几轮负责，需求 / 路网 / 票价的指纹随快照一起存：
  // 载入时若部分输入不同（例如只换了票价），只作废受影响的那部分，不必整份丢掉重算四轮。
  function guardParts(g){
    const m=g.model,r=m.road,n=m.net,rd=m.roadData;
    // 指纹只认内容，不认 roadVer：那是个跨进程从 0 重新数起的计数器，
    // 把它掺进来会让同一份路网在另一次启动里算出不同的哈希，缓存永远命不中。
    let road=roadGuards.get(rd);
    if(!road||road.graph!==r){road={graph:r,hash:arrayGuards([r.outStart,r.outArc,r.arcFrom,r.arcTo,r.arcT0,r.arcCap,rd.start,rd.nodes,rd.times,rd.km])};roadGuards.set(rd,road);}
    let metro=metroGuards.get(n);if(!metro){metro=arrayGuards([n.eFrom,n.eTo,n.eT0]);metroGuards.set(n,metro);}
    // od / year / fare / city 每次变化都会换新对象或新值，只需记录引用与版本号，不必再做数组指纹
    return {map:g.mapId||'',road:road.hash.concat(metro).join(','),od:m.od&&m.od.key||'',year:m.year,
      fare:CM.Model.fareKey(m.fare),city:(m.city.version||0)+'/'+(m.city.roadVersion||0),net:m.routeKey||[]};
  }
  function guard(g){const p=guardParts(g);return JSON.stringify([p.map,p.road,p.od,p.year,p.fare,p.city,p.net]);}
  // 部分命中时缺的那部分：road / od / fare 任一不同都要重算迭代（它们决定「谁和谁之间怎么走」），
  // year / city 只影响系数，快照里的结果可以接着用；net 变了说明线网本身变了，整份作废。
  function sameNet(a,b){if(!a||!b||a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true;}
  function diffParts(meta,g){
    const p=guardParts(g);let m;try{m=JSON.parse(meta.guard);}catch(e){return null;}
    if(!m||m[0]!==p.map||!sameNet(m[6],p.net))return null;
    const full=m[1]!==p.road||m[2]!==p.od||m[4]!==p.fare;
    return {full:full,reuse:!full};
  }
  function capture(g){
    const m=g&&g.model;
    // 只要求「有一份可用的解」，正在逐帧收敛也照样缓存（载入时按 solveSteps 决定还要补算几轮）。
    // m.gen 是逐帧推进的生成器，正常游玩中它几乎总是非空——拿它当门槛等于一条也存不进去；
    // 真正会读到半成品的是正在同步求解（solving）和正处在结算/跳月（pending/jumping）的瞬间。
    if(leasedBytes>=MAX_ENTRY/2||!CM.SIM_STAMP||!m||m.solving||g.pending||g.jumping||m.predJob)return null;
    try{
      const periods=[];let bytes=0;
      for(const dt of ['wd','we'])for(let p=0;p<4;p++){
        const P=m.ctxs[dt].per[p],entry={dt,p,arrays:[],scalars:{}};
        for(const name of Object.keys(P))if(ArrayBuffer.isView(P[name])){const a=P[name];bytes=Math.ceil(bytes/8)*8;entry.arrays.push({name,type:a.constructor.name,length:a.length,offset:bytes});bytes+=a.byteLength;}
        for(const k of scalars)if(P[k]!==undefined)entry.scalars[k]=clone(P[k]);periods.push(entry);
      }
      if(bytes>MAX_ENTRY||bytes+leasedBytes>MAX_ENTRY)return null;const data=new ArrayBuffer(bytes),out=new Uint8Array(data);
      for(const row of periods)for(const a of row.arrays){const v=m.ctxs[row.dt].per[row.p][a.name];out.set(new Uint8Array(v.buffer,v.byteOffset,v.byteLength),a.offset);}
      const counters={cycles:m.cycles,settled:!!m.settled,solveLimit:m.solveLimit||2};
      const snapshot={meta:{schema:3,stamp:CM.SIM_STAMP,guard:guard(g),periods,counters},data};leases.set(snapshot,bytes);leasedBytes+=bytes;return snapshot;
    }catch(e){return null;}
  }
  function put(checksum,snapshot){
    if(!checksum||!snapshot){discard(snapshot);return Promise.resolve(false);}const k=key(checksum);
    const job=chain.then(async()=>{
      try{
        if(desk()){
          const dataHash=await digest(snapshot.data),metaHash=await metaDigest(snapshot.meta,dataHash);
          await deskPut(k,snapshot,dataHash,metaHash);await deskTrim();return true;
        }
        const db=await open();if(!db)return false;const dataHash=await digest(snapshot.data),metaHash=await metaDigest(snapshot.meta,dataHash);
        await transaction(db,['entries','lru'],'readwrite',tx=>{
          tx.objectStore('entries').put({...snapshot,dataHash,metaHash},k);
          tx.objectStore('lru').put({key:k,bytes:snapshot.data.byteLength,used:Date.now()});
          const request=tx.objectStore('lru').index('used').getAll();
          request.onsuccess=()=>{const rows=request.result;let bytes=rows.reduce((n,row)=>n+row.bytes,0),count=rows.length;for(const row of rows)if(bytes>MAX_TOTAL||count>MAX_COUNT){tx.objectStore('entries').delete(row.key);tx.objectStore('lru').delete(row.key);bytes-=row.bytes;count--;}};
        },5000);return true;
      }catch(e){return false;}
    });chain=job.catch(()=>false);pending.set(k,job);job.finally(()=>{discard(snapshot);if(pending.get(k)===job)pending.delete(k);});return job;
  }
  function discard(snapshot){const n=snapshot&&leases.get(snapshot);if(n!==undefined){leasedBytes-=n;leases.delete(snapshot);}}
  async function get(checksum){
    if(!CM.SIM_STAMP||!checksum)return null;const k=key(checksum);
    try{
      if(pending.has(k)){
        let timer;try{if(!await Promise.race([pending.get(k),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1500);})]))return null;}finally{clearTimeout(timer);}
      }
      // 桌面版：快照以文件形式留在宿主数据目录，下次启动仍然命中
      if(desk()){
        const saved=await deskGet(k);
        if(!saved||!saved.meta||saved.meta.schema!==3||saved.meta.stamp!==CM.SIM_STAMP||!saved.data||typeof saved.data.byteLength!=='number'||saved.data.byteLength>MAX_ENTRY)return null;
        const savedHash=await digest(saved.data);
        if(savedHash!==saved.meta.dataHash)return null;
        const bare=Object.assign({},saved.meta);delete bare.dataHash;delete bare.metaHash;
        if(await metaDigest(bare,savedHash)!==saved.meta.metaHash)return null;
        touch(k);verified.add(saved);return saved;
      }
      const db=await open();if(!db)return null;
      const record=await transaction(db,'entries','readonly',tx=>{let value;const request=tx.objectStore('entries').get(k);request.onsuccess=()=>{value=request.result;};return()=>value;});
      if(!record||record.meta.schema!==3||record.meta.stamp!==CM.SIM_STAMP||!(record.data instanceof ArrayBuffer)||record.data.byteLength>MAX_ENTRY)return null;
      const hash=await digest(record.data);if(hash!==record.dataHash||await metaDigest(record.meta,hash)!==record.metaHash)return null;
      transaction(db,['entries','lru'],'readwrite',tx=>{const request=tx.objectStore('entries').getKey(k);request.onsuccess=()=>{if(request.result!==undefined)tx.objectStore('lru').put({key:k,bytes:record.data.byteLength,used:Date.now()});};}).catch(()=>{});verified.add(record);return record;
    }catch(e){return null;}
  }
  function restore(g,record){
    if(!record||!verified.has(record)||!record.data||typeof record.data.byteLength!=='number')return false;
    try{
      const m=g.model,meta=record.meta,C=meta.counters;
      // 指纹只允许 year / city 不同（它们只是系数），线网、路网、需求、票价变了都不能用旧结果
      const d=diffParts(meta,g);
      if(meta.stamp!==CM.SIM_STAMP||!d||!d.reuse||meta.periods.length!==8||!C||!Number.isInteger(C.solveLimit)||C.solveLimit<1||C.solveLimit>12||['cycles'].some(k=>!Number.isSafeInteger(C[k])||C[k]<0))return false;
      const staged=[];const seen=new Set();
      for(const row of meta.periods){
        if(!['wd','we'].includes(row.dt)||!Number.isInteger(row.p)||row.p<0||row.p>3||seen.has(row.dt+row.p))return false;seen.add(row.dt+row.p);
        const P=m.ctxs[row.dt].per[row.p],S=row.scalars,E=S.error;m.allocStatArrays(P);
        if(!Number.isSafeInteger(S.solveSteps)||S.solveSteps<1||!Number.isSafeInteger(S.quiet)||S.quiet<0||typeof S.stable!=='boolean'||![0,12].includes(S.reviewLimit)||!E||Object.values(E).some(v=>!Number.isFinite(v))||!S.stats||Object.values(S.stats).some(v=>!Number.isFinite(v))||S.facKey!==m.fn.key)return false;
        const values={},keys=Object.keys(P).filter(k=>ArrayBuffer.isView(P[k]));if(row.arrays.length!==keys.length)return false;
        for(const a of row.arrays){const old=P[a.name];if(!keys.includes(a.name)||values[a.name]||!old||a.type!==old.constructor.name||a.length!==old.length||!Number.isInteger(a.offset)||a.offset<0||a.offset%old.BYTES_PER_ELEMENT)return false;const v=new old.constructor(record.data,a.offset,a.length);values[a.name]=v;}
        staged.push({P,S,values});
      }
      for(const {P,S,values}of staged){for(const k of scalars)if(S[k]!==undefined)P[k]=S[k];Object.assign(P,values);P.solveSignature={net:m.net,od:m.od,year:m.year,fare:CM.Model.fareKey(m.fare),road:m.roadVer};}
      verified.delete(record);
      m.computeDaily();m.gen=null;Object.assign(m,C);
      m.settledAt={year:m.year,fare:CM.Model.fareKey(m.fare),city:m.city.version,road:m.city.roadVersion,net:m.net,od:m.od};g.trafficCacheHit=true;
      // 存档时那份解还没收敛：沿用当时剩下的轮数，让求解器接着跑，而不是把它丢掉重来
      const left=Math.max(0,Math.min(12,(m.solveLimit||2)-(m.cycles||0)));
      m.settled=left===0&&m.ctxs.wd.per.every(P=>P.stable)&&m.ctxs.we.per.every(P=>P.stable);
      return true;
    }catch(e){return false;}
  }
  function track(g,checksum){const m=g.model;g._trafficCacheTarget={checksum,net:m.net,od:m.od,year:m.year,fare:CM.Model.fareKey(m.fare),road:m.roadVer};tick(g);}
  function tick(g){
    const t=g._trafficCacheTarget;if(!t)return;const m=g.model;
    if(t.net!==m.net||t.od!==m.od||t.year!==m.year||t.fare!==CM.Model.fareKey(m.fare)||t.road!==m.roadVer){g._trafficCacheTarget=null;return;}
    // 与 capture 的准入保持一致：有一份解就写，不再等它完全收敛；每轮最多试一次，避免重复序列化
    if(g.pending||g.jumping||m.predJob||m.solving)return;
    if(m.settled){g._trafficCacheTarget=null;put(t.checksum,capture(g));return;}
    if(t.tries>=(m.solveLimit||2))return;
    t.tries=(t.tries||0)+1;put(t.checksum,capture(g));
  }
  async function flush(){let timer;try{return await Promise.race([chain,new Promise(r=>{timer=setTimeout(()=>r(false),1500);})]);}finally{clearTimeout(timer);}}
  CM.TrafficCache={capture,put,get,restore,track,tick,discard,keyFor,flush};
})(window.CM);
