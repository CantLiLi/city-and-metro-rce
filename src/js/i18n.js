'use strict';
// Display-only localization: model strings, save files, IDs and editable values remain canonical.
(function(CM){
  const allowed=['zh-CN','zh-TW','en'],hasHan=s=>/[\u3400-\u9fff]/.test(s),cache=new Map(),sources=new WeakMap(),attrs=new WeakMap(),listeners=new Set();
  let language='zh-CN',traditional=null,namesReady=false,trie=null,templates=null;
  try{const s=JSON.parse(localStorage.getItem('cm1.settings')||'null');if(s&&allowed.includes(s.language))language=s.language;}catch(e){/* settings unavailable */}
  const en=CM.I18N_EN||Object.create(null),names=new Map(),nameLengths=new Map(),missing=new Set();
  const compactFormat=new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:2});
  function sanitize(s){return s.replace(/笕桥机场(?:[（(]军用[）)])?/g,'城东片区').replace(/王家墩机场(?:[（(]军用[）)])?/g,'王家墩片区').replace(/军用机场[^，。；\n]*/g,'未开发用地');}
  function nameEnglish(s){
    if(en[s])return en[s];
    const suffix=[['街道','Subdistrict'],['自治区','Region'],['特别行政区',''],['风景名胜区','Scenic Area'],['国家湿地公园','Wetland Park'],['森林公园','Forest Park'],['火车站','Railway Station'],['地铁站','Station'],['国际机场','International Airport'],['机场','Airport'],['大学','University'],['医院','Hospital'],['公园','Park'],['大桥','Bridge'],['高架路','Viaduct'],['隧道','Tunnel'],['大道','Avenue'],['大街','Avenue'],['广场','Square'],['水库','Reservoir'],['街','Street'],['路','Road'],['河','River'],['江','River'],['区','District'],['镇','Town'],['市','City']];
    let tail='',stem=s;for(const [a,b]of suffix)if(s.endsWith(a)&&s.length>a.length){stem=s.slice(0,-a.length);tail=b;break;}
    const roman=window.pinyinPro?window.pinyinPro.pinyin(stem,{toneType:'none',type:'array'}).map(x=>x.charAt(0).toUpperCase()+x.slice(1)).join(''):stem;
    return roman+(tail?' '+tail:'');
  }
  function initNames(){
    if(namesReady||!CM.MAPS)return;namesReady=true;
    for(const m of Object.values(CM.MAPS)){
      const list=[...(m.geo.names||[]),...(m.data.landmarks||[]).map(x=>x.name),...(m.data.regions||[]).map(x=>x.name),...(m.data.facilities||[]).map(x=>x.n),...(m.data.districtLabels||[]).map(x=>x[0]),...Object.keys(m.data.roadYears||{}),...Object.keys(m.data.bridgeYears||{}),...(m.data.places||[]).map(x=>Array.isArray(x)?x[0]:x.name)];
      if(m.data.defaultRegion)list.push(m.data.defaultRegion.name);
      for(const task of m.data.histTasks||[])for(const anchor of task.anchors||[])list.push(anchor.name);
      for(const raw of list)if(typeof raw==='string')for(const s of new Set([raw,raw.replace(/（.*?）/g,'').trim()]))if(s.length>1&&s.length<80&&!en[s]){
        names.set(s,null);nameLengths.set(s[0],Math.max(nameLengths.get(s[0])||0,s.length));
      }
    }
  }
  function initTrie(){
    if(trie)return;trie=new Map();
    for(const [source,target]of Object.entries(en)){if(!source||!hasHan(source))continue;let n=trie;for(const c of source){if(!n.has(c))n.set(c,new Map());n=n.get(c);}n.out=target;}
  }
  function english(s){
    if(en[s]!==undefined)return en[s];initNames();if(names.has(s)){let v=names.get(s);if(!v){v=nameEnglish(s);names.set(s,v);}return v;}initTrie();
    if(!templates)templates=Object.entries(en).filter(([k])=>/\{[\w.]+\}/.test(k)).map(([key,target])=>{const keys=[];let last=0,pattern='^';for(const m of key.matchAll(/\{([\w.]+)\}/g)){pattern+=key.slice(last,m.index).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(.+?)';keys.push(m[1]);last=m.index+m[0].length;}pattern+=key.slice(last).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$';return {re:new RegExp(pattern),keys,target};});
    for(const t of templates){const m=t.re.exec(s);if(m)return t.target.replace(/\{([\w.]+)\}/g,(_,k)=>text(m[t.keys.indexOf(k)+1]));}
    // 数字与币种仅在显示时转换；游戏日志和存档仍由原始格式函数生成。
    const compact=n=>compactFormat.format(n);
    s=s.replace(/(-?\d[\d,]*(?:\.\d+)?)\s*(亿|万)?(新台币|新法郎|欧元|法郎|人民币|日元|港币|元)/g,(_,n,scale,unit)=>{
      const codes={'新台币':'TWD','新法郎':'FRF','法郎':'FRF','欧元':'EUR','人民币':'CNY','日元':'JPY','港币':'HKD'};
      return compact(Number(n.replace(/,/g,''))*(scale==='亿'?1e8:scale==='万'?1e4:1))+' '+(codes[unit]||(CM.CFG&&CM.CFG.money&&CM.CFG.money.code)||'CNY');
    }).replace(/(-?\d[\d,]*(?:\.\d+)?)\s*万/g,(_,n)=>compact(Number(n.replace(/,/g,''))*1e4));
    s=s.replace(/(\d+)\s*号线/g,'Line $1').replace(/(\d+)\s*条线路/g,(_,n)=>n+(+n===1?' line':' lines')).replace(/(\d+)\s*座车站/g,(_,n)=>n+(+n===1?' station':' stations')).replace(/(\d+)\s+站/g,(_,n)=>n+(+n===1?' station':' stations')).replace(/(\d+)\s*项历史任务/g,'$1 historical tasks').replace(/(\d+)\s*个里程碑/g,(_,n)=>n+(+n===1?' milestone':' milestones')).replace(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g,'$1-$2-$3').replace(/(\d{4})\s*年\s*(\d{1,2})\s*月/g,'$1-$2');
    // Prefer the longest phrase; a place name inside a translated sentence must not break that sentence.
    let out='',i=0;while(i<s.length){
      let n=trie,end=-1,value='';for(let j=i;j<s.length&&n.has(s[j]);j++){n=n.get(s[j]);if(n.out!==undefined){end=j+1;value=n.out;}}
      for(let len=Math.min(nameLengths.get(s[i])||0,s.length-i);len>Math.max(1,end-i);len--){
        const candidate=s.slice(i,i+len);if(!names.has(candidate))continue;
        value=names.get(candidate);if(!value){value=nameEnglish(candidate);names.set(candidate,value);}end=i+len;break;
      }
      if(end>=0){out+=' '+value+' ';i=end;}else out+=s[i++];
    }
    if(hasHan(out)&&missing.size<128)missing.add(s);
    const result=out.replace(/[ \t]+/g,' ').replace(/\s+([.,:;!?%\)\]])/g,'$1').replace(/([\(\[])\s+/g,'$1').replace(/，/g,', ').replace(/。/g,'. ').replace(/：/g,': ').replace(/；/g,'; ').replace(/[「『]/g,'“').replace(/[」』]/g,'”').replace(/（/g,' (').replace(/）/g,') ').trim();
    return (/^\s/.test(s)?' ':'')+result+(/\s$/.test(s)?' ':'');
  }
  function text(value){
    if(typeof value!=='string'||!hasHan(value))return value;
    const key=value;let result=cache.get(key);if(result!==undefined)return result;
    // Paths and URLs are data. Preserve them byte-for-byte, including Chinese directory names.
    const protectedParts=[];
    const source=sanitize(value.replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\r\n<>"|]*|https?:\/\/[^\s<>"）)]+/g,p=>{const token='\uE000'+protectedParts.length+'\uE001';protectedParts.push(p);return token;}));
    const restore=s=>s.replace(/\uE000(\d+)\uE001/g,(_,i)=>protectedParts[+i]);
    if(language==='zh-CN'||!hasHan(source))return restore(source);
    if(language==='zh-TW'){if(!traditional)traditional=window.OpenCC.Converter({from:'cn',to:'tw'});result=traditional(source);}else result=english(source);
    result=restore(result);
    if(cache.size>12000)cache.delete(cache.keys().next().value);cache.set(key,result);return result;
  }
  function excluded(el){return !el||!!el.closest('script,style,textarea,input,pre,code,[contenteditable="true"],[data-no-i18n]');}
  function node(n){
    if(n.nodeType!==3||excluded(n.parentElement))return;const current=n.nodeValue,old=sources.get(n),source=old&&old.last===current?old.source:current,last=text(source);
    if(last!==current)n.nodeValue=last;sources.set(n,{source,last});
  }
  const attrKeys=['title','aria-label','placeholder','data-tip','alt'];
  function element(el){
    if(el.closest('script,style,pre,code,[data-no-i18n]'))return;let rec=attrs.get(el);if(!rec){rec=new Map();attrs.set(el,rec);}for(const key of attrKeys){if(!el.hasAttribute(key))continue;const current=el.getAttribute(key),old=rec.get(key),source=old&&old.last===current?old.source:current,last=text(source);if(last!==current)el.setAttribute(key,last);rec.set(key,{source,last});}
  }
  function localize(root){
    if(!root)return;if(root.nodeType===3){node(root);return;}if(root.nodeType===1)element(root);
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);for(let n=walker.nextNode();n;n=walker.nextNode()){if(n.nodeType===3)node(n);else element(n);}
  }
  function invalidate(){
    const R=CM.R;if(R){R.clearImages();R.dropThemeStash();R.textWidths.clear();R._rk=null;R.labelImage=null;R.lastLabelKey=null;R.labelSprites.forEach(x=>{x.cv.width=x.cv.height=1;});R.labelSprites.clear();R.labelSpritePx=0;R.overview=null;R.overviewStale=true;R.heatKey='';}
    if(CM.ui){if(CM.ui.g())CM.ui.updateTop();const coach=document.getElementById('coach');if(coach)document.documentElement.style.setProperty('--coach-h',coach.offsetHeight+'px');CM.ui.layoutHud();}
    if(CM.Stats&&CM.Stats.isOpen())CM.Stats.redraw();if(CM.NetMap)CM.NetMap.refresh(true);
  }
  function apply(next){
    if(!allowed.includes(next))next='zh-CN';language=next;cache.clear();
    if(typeof document==='undefined')return;document.documentElement.lang=language;document.documentElement.dataset.language=language;
    localize(document.body);document.title=text('城市与地铁');invalidate();for(const f of listeners)f(language);
  }
  CM.I18n={text,get:()=>language,apply,localize,name:nameEnglish,search:s=>(String(s)+' '+text(String(s))).toLowerCase(),on(fn){listeners.add(fn);return()=>listeners.delete(fn);},missing:()=>[...missing]};
  if(typeof document==='undefined')return;
  // Translate newly constructed controls before callers measure or attach them.
  const h=CM.U.h;CM.U.h=function(){const el=h.apply(this,arguments);localize(el);return el;};
  const prototypes=[window.CanvasRenderingContext2D&&window.CanvasRenderingContext2D.prototype,window.OffscreenCanvasRenderingContext2D&&window.OffscreenCanvasRenderingContext2D.prototype];
  for(const proto of prototypes)if(proto)for(const key of ['fillText','strokeText','measureText']){const base=proto[key];proto[key]=function(value){const args=Array.from(arguments);args[0]=text(String(value));return base.apply(this,args);};}
  // Observe changed nodes only; source text is retained so switching back never translates a translation.
  const observer=new MutationObserver(records=>{observer.disconnect();for(const r of records){if(r.type==='characterData')node(r.target);else if(r.type==='attributes')element(r.target);else for(const n of r.addedNodes)localize(n);}observe();});
  function observe(){observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:attrKeys});}
  apply(language);observe();
})(window.CM);
