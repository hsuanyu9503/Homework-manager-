#!/usr/bin/env node
/*
 * Classroom Manager v2.102 — 個別評量成績級距：回歸測試（僅供開發，網站不載入）。
 *
 * 執行方式：
 *   SITE_DIR=<v2.102 網站資料夾> [V2101_DIR=<v2.101 網站資料夾>] node tests/grade-bands.test.js
 *   - SITE_DIR 預設為本檔上一層資料夾。
 *   - 提供 V2101_DIR 時，另比對 v2.101：資料安全／匯入核心函式原文、Excel 匯出內容、版面寬度基準。
 *
 * - 以 127.0.0.1 隨機埠啟動獨立靜態伺服器，每個案例使用全新的 Playwright browser context（臨時設定檔）。
 * - 全部為虛構資料；不使用、不讀取任何真實學生資料。
 * - 需要可 require('playwright') 的環境（Chromium）。
 */
"use strict";
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const SITE_DIR = path.resolve(process.env.SITE_DIR || path.join(__dirname, ".."));
const V2101_DIR = process.env.V2101_DIR ? path.resolve(process.env.V2101_DIR) : null;
const STORAGE_KEY = "homeworkTrackerDataV2";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hm-grade-bands-"));

/* ---------------- 虛構資料（v2.100 舊格式：沒有 syncRevision） ---------------- */
const STUDENTS = Array.from({length:10},(_,i)=>({id:`s${String(i+1).padStart(2,"0")}`,number:i+1,name:`測試學生${String(i+1).padStart(2,"0")}`,tags:[]}));
const XSS_TITLE = `<img src=x onerror="window.__xss=1">"'&<b>粗體</b>`;
const LONG_TITLE = "超長評量名稱".repeat(12) + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".repeat(3);
const ITEMS = [
  {id:"g-b100",subjectId:"sub-math",title:"數學單元一（100 分界線）",date:"2026-09-01",createdAt:"2026-09-01T00:00:00.000Z",maxScore:100,gradeTerm:"midterm",
    scores:{s01:100,s02:90,s03:89.99,s04:80,s05:79.99,s06:70,s07:69.99,s08:60,s09:59.99,s10:0}},
  {id:"g-b50",subjectId:"sub-chinese",title:"國語小考（滿分 50）",date:"2026-09-02",createdAt:"2026-09-02T00:00:00.000Z",maxScore:50,gradeTerm:"final",
    scores:{s01:45,s02:44.995,s03:40,s04:39.995,s05:35,s06:34.995,s07:30,s08:29.995,s09:0}},
  {id:"g-b20",subjectId:"sub-math",title:"數學速算（滿分 20）",date:"2026-09-03",createdAt:"2026-09-03T00:00:00.000Z",maxScore:"20",
    scores:{s01:18,s02:17.998,s03:16,s04:14,s05:12,s06:11.99,s07:"",s08:"   ",s09:null}},
  {id:"g-none",subjectId:"sub-chinese",title:"全未登記評量",date:"2026-09-04",createdAt:"2026-09-04T00:00:00.000Z",maxScore:100,gradeTerm:"midterm",scores:{}},
  {id:"g-badmax",subjectId:"sub-math",title:"滿分異常評量",date:"2026-09-05",createdAt:"2026-09-05T00:00:00.000Z",maxScore:0,gradeTerm:"final",scores:{s01:80,s02:null,s03:"72"}},
  {id:"g-badscore",subjectId:"sub-math",title:"異常分數評量",date:"2026-09-06",createdAt:"2026-09-06T00:00:00.000Z",maxScore:100,
    scores:{s01:-5,s02:"abc",s03:true,s04:{},s05:"Infinity",s06:"85",s07:" 72.5 ",s08:105,s09:0,"s-ghost":95}},
  {id:"g-xss",subjectId:"sub-chinese",title:XSS_TITLE,date:"2026-09-07",createdAt:"2026-09-07T00:00:00.000Z",maxScore:10,scores:{s01:9,s02:5}},
  {id:"g-long",subjectId:"",title:LONG_TITLE,date:"2026-09-08",createdAt:"2026-09-08T00:00:00.000Z",maxScore:100,scores:{s01:61}}
];
function classData(){
  return {version:1,class:{name:"虛構級距測試班"},students:STUDENTS,assignments:[],records:[],
    subjects:[{id:"sub-chinese",name:"國語"},{id:"sub-math",name:"數學"}],
    gradeItems:ITEMS, scores:{}, settings:{gradeTermsEnabled:true}};
}
const SEED = {version:2,classes:[
  {id:"cG",name:"虛構級距測試班",createdAt:"2026-01-01T00:00:00.000Z",data:classData()},
  {id:"cOther",name:"虛構其他班",createdAt:"2026-01-01T00:00:00.000Z",data:{class:{name:"虛構其他班"},students:[],assignments:[],records:[],gradeItems:[],subjects:[]}}
]};
// 預期：[有效, 未登記, 異常, 超滿分, 名單外, [90+,80,70,60,<60]]
const EXPECT = {
  "g-b100":{valid:10,empty:0,invalid:0,overMax:0,outside:0,bands:[2,2,2,2,2]},
  "g-b50":{valid:9,empty:1,invalid:0,overMax:0,outside:0,bands:[1,2,2,2,2]},
  "g-b20":{valid:6,empty:4,invalid:0,overMax:0,outside:0,bands:[1,2,1,1,1]},
  "g-none":{valid:0,empty:10,invalid:0,overMax:0,outside:0,bands:[0,0,0,0,0]},
  "g-badmax":{valid:0,empty:8,invalid:2,overMax:0,outside:0,bands:[0,0,0,0,0]},
  "g-badscore":{valid:4,empty:1,invalid:5,overMax:1,outside:1,bands:[1,1,1,0,1]},
  "g-xss":{valid:2,empty:8,invalid:0,overMax:0,outside:0,bands:[1,0,0,0,1]},
  "g-long":{valid:1,empty:9,invalid:0,overMax:0,outside:0,bands:[0,0,0,1,0]}
};

/* ---------------- 靜態伺服器 ---------------- */
const TYPES = {".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"};
function startServer(root){
  const server = http.createServer((req,res)=>{
    const rel = decodeURIComponent(new URL(req.url,"http://x").pathname).replace(/^\/+/,"") || "index.html";
    if(!["index.html","app.js","style.css"].includes(rel)){ res.writeHead(404); return res.end(); }
    res.writeHead(200,{"Content-Type":TYPES[path.extname(rel)]});
    fs.createReadStream(path.join(root,rel)).pipe(res);
  });
  return new Promise(r=>server.listen(0,"127.0.0.1",()=>r(server)));
}

/* ---------------- 工具 ---------------- */
const results = [];
function check(name, cond, detail){
  results.push({name, ok:!!cond});
  console.log(`${cond?"PASS":"FAIL"}  ${name}${!cond&&detail!==undefined?`\n      ${typeof detail==="string"?detail:JSON.stringify(detail)}`:""}`);
}
async function newSite(browser, base, opts={}){
  const context = await browser.newContext({acceptDownloads:true, viewport:opts.viewport||{width:1365,height:900}, hasTouch:!!opts.touch});
  const page = await context.newPage();
  page.__errors = []; page.__dialogs = [];
  page.on("pageerror", e=>page.__errors.push(e.message));
  page.on("dialog", d=>{ page.__dialogs.push(d.message()); d.accept(); });
  await page.goto(base);
  await page.evaluate(([k,v,v1])=>{ localStorage.clear(); if(v) localStorage.setItem(k,v); if(v1) localStorage.setItem("homeworkTrackerDataV1",v1); }, [STORAGE_KEY, opts.legacyV1?null:JSON.stringify(opts.seed||SEED), opts.legacyV1||null]);
  await page.reload();
  if(!opts.noEnter){
    await page.evaluate(id=>{ enterClass(id); setPage("gradebook"); }, opts.classId || await page.evaluate(()=>store.classes[0].id));
    await flush(page);
  }
  return {context, page};
}
const flush = page => page.evaluate(async()=>{ try{ if(typeof __commitTail!=="undefined") await __commitTail; }catch(e){} });
const readMeta = page => page.evaluate(()=>new Promise(res=>{ try{ const r=indexedDB.open("homeworkTrackerSync",1);
  r.onsuccess=()=>{ try{ const q=r.result.transaction("meta","readonly").objectStore("meta").get("homeworkTrackerDataV2"); q.onsuccess=()=>{ r.result.close(); res(q.result||null); }; q.onerror=()=>res("err"); }catch(e){ res("no-store"); } };
  r.onerror=()=>res("err"); }catch(e){ res("no-idb"); } }));
async function snapshot(page){
  await flush(page);
  return {ls: await page.evaluate(k=>localStorage.getItem(k), STORAGE_KEY), meta: JSON.stringify(await readMeta(page)),
    mem: await page.evaluate(()=>JSON.stringify(store)), active: await page.evaluate(()=>JSON.stringify(data))};
}
async function armWriteSpy(page){
  await page.evaluate(()=>{
    window.__writeCalls = {saveData:0, persistStoreSafely:0, commitStoreOnce:0, setItem:0};
    for(const fn of ["saveData","persistStoreSafely","commitStoreOnce"]){
      const orig = window[fn]; window[fn] = function(){ window.__writeCalls[fn]++; return orig.apply(this, arguments); };
    }
    const origSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function(){ window.__writeCalls.setItem++; return origSet.apply(this, arguments); };
  });
}
const writeCalls = page => page.evaluate(()=>window.__writeCalls);
const modalState = page => page.evaluate(()=>{
  const back=document.getElementById("modalBackdrop"), body=document.getElementById("modalBody"), v=body.querySelector(".grade-band-view");
  const num = label => { const dt=[...body.querySelectorAll(".grade-band-counts dt")].find(x=>x.textContent===label); return dt?Number(dt.nextElementSibling.textContent):null; };
  return {open:!back.classList.contains("hidden"), band:!!v, editor:!!body.querySelector(".grade-score-input"),
    title: v?.querySelector(".grade-band-title")?.textContent ?? null, meta: v?.querySelector(".grade-band-meta")?.textContent ?? "",
    total:num("全班人數"), valid:num("有效登記"), empty:num("未登記"), invalid:num("異常"),
    bands:[...body.querySelectorAll(".grade-band-table tbody tr")].map(tr=>({label:tr.querySelector("th").textContent, count:Number(tr.children[1].textContent), pct:tr.querySelector(".grade-band-percent").textContent})),
    notes:[...body.querySelectorAll(".grade-band-alert,.grade-band-note")].map(n=>n.textContent), text: v?.innerText||"",
    imgInModal: body.querySelectorAll("img").length, modalClass: document.querySelector("#modalBackdrop .modal").className,
    labelledby: document.querySelector("#modalBackdrop .modal").getAttribute("aria-labelledby")};
});
const activeBand = page => page.evaluate(()=>{ const a=document.activeElement; return a?{tag:a.tagName, id:a.id, band:a.dataset?.gradeBand||null, source:a.dataset?.gradeBandSource||null, text:a.textContent?.trim().slice(0,20)}:null; });
const overviewBtn = (page,id) => page.locator(`#gradebookOverview button[data-grade-band="${id}"]`);
const registerBtn = (page,id) => page.locator(`#gradebookList button[data-grade-band="${id}"]`);
async function showView(page, view){ await page.locator(`[data-grade-view="${view}"]`).click(); }
function sumBands(b){ return b.reduce((a,x)=>a+(typeof x==="number"?x:x.count),0); }
function pctOf(count, valid){ return valid>0 ? `${(count/valid*100).toFixed(1)}%` : "—"; }
function checkModalAgainst(label, m, id){
  const e = EXPECT[id];
  check(`${label}：視窗為級距檢視（非成績編輯）`, m.open && m.band && !m.editor, {open:m.open, band:m.band, editor:m.editor});
  check(`${label}：評量名稱正確`, m.title === ITEMS.find(i=>i.id===id).title, m.title);
  check(`${label}：人數（全班/有效/未登記/異常）`, m.total===10 && m.valid===e.valid && m.empty===e.empty && m.invalid===e.invalid, {total:m.total, valid:m.valid, empty:m.empty, invalid:m.invalid});
  check(`${label}：各級距人數`, JSON.stringify(m.bands.map(b=>b.count))===JSON.stringify(e.bands), m.bands.map(b=>b.count));
  check(`${label}：占比（有效登記為分母、小數一位）`, m.bands.every((b,i)=>b.pct===pctOf(e.bands[i], e.valid)), m.bands.map(b=>b.pct));
  check(`${label}：全班＝有效＋未登記＋異常；級距總和＝有效`, m.total===m.valid+m.empty+m.invalid && sumBands(m.bands)===m.valid);
  check(`${label}：沒有 NaN／Infinity`, !/NaN|Infinity/.test(m.text), m.text.match(/.{0,20}(NaN|Infinity).{0,20}/)?.[0]);
}

/* ---------------- 案例 ---------------- */
async function run(){
  const server = await startServer(SITE_DIR);
  const base = `http://127.0.0.1:${server.address().port}/index.html`;
  let oldServer = null, oldBase = null;
  if(V2101_DIR){ oldServer = await startServer(V2101_DIR); oldBase = `http://127.0.0.1:${oldServer.address().port}/index.html`; }
  const browser = await chromium.launch({env:{...process.env, LANG:process.env.LANG && /UTF-?8/i.test(process.env.LANG) ? process.env.LANG : "C.UTF-8"}});
  try{
    /* [1] 語法、HTML、CSS 與版本 */
    { const js = fs.readFileSync(path.join(SITE_DIR,"app.js"),"utf8"), html = fs.readFileSync(path.join(SITE_DIR,"index.html"),"utf8"), css = fs.readFileSync(path.join(SITE_DIR,"style.css"),"utf8");
      let syntaxOk = true; try{ execFileSync(process.execPath, ["--check", path.join(SITE_DIR,"app.js")], {stdio:"pipe"}); }catch(e){ syntaxOk = false; }
      check("[1] app.js 語法檢查（node --check）", syntaxOk);
      const refs = [...html.matchAll(/(?:src|href)="([^"#?]+)(?:\?v=([^"]+))?"/g)].filter(m=>!/^(https?:|mailto:|data:)/.test(m[1]));
      check("[1] index.html 引用的本地資源都存在", refs.length>=2 && refs.every(m=>fs.existsSync(path.join(SITE_DIR,m[1]))), refs.map(m=>m[1]));
      check("[1] 沒有引用外部 CDN 或網路資源", !/<script[^>]+src="https?:|<link[^>]+href="https?:/i.test(html) && !/@import\s+url\(\s*["']?https?:/i.test(css));
      { const ver = (js.match(/const APP_VERSION = "([0-9.]+)";/)||[])[1], expect = process.env.EXPECT_VERSION || "2.103";
        const badges = [...html.matchAll(/version-badge">v([0-9.]+)</g)].map(m=>m[1]), params = [...html.matchAll(/(?:style\.css|app\.js)\?v=([0-9.]+)"/g)].map(m=>m[1]);
        check(`[1] 版本標記一致為 ${expect}（APP_VERSION、徽章、快取參數）`, ver===expect && badges.length===2 && params.length===2 && [...badges,...params].every(v=>v===ver), {ver, badges, params}); }
      let depth=0, minDepth=0; for(const ch of css.replace(/\/\*[\s\S]*?\*\//g,"").replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,"")){ if(ch==="{")depth++; else if(ch==="}"){depth--; minDepth=Math.min(minDepth,depth);} }
      check("[1] style.css 大括號配對完整", depth===0 && minDepth===0, {depth, minDepth});
      const {context, page} = await newSite(browser, base, {noEnter:true});
      const dom = await page.evaluate(()=>({rules:[...document.styleSheets].reduce((a,s)=>a+s.cssRules.length,0), bandRules:[...document.styleSheets[0].cssRules].filter(r=>String(r.cssText).includes("grade-band")).length,
        badge:document.querySelector(".version-badge")?.textContent, ids:[...document.querySelectorAll("[id]")].map(e=>e.id)}));
      check("[1] 瀏覽器載入 CSS 規則且包含級距樣式", dom.rules>100 && dom.bandRules>=20, dom);
      check("[1] index.html 沒有重複的 id", new Set(dom.ids).size===dom.ids.length, dom.ids.filter((x,i)=>dom.ids.indexOf(x)!==i));
      check("[1] 頁面載入沒有 JavaScript 錯誤", page.__errors.length===0, page.__errors);
      if(oldBase){
        const o = await newSite(browser, oldBase, {noEnter:true});
        const oldRules = await o.page.evaluate(()=>[...document.styleSheets].reduce((a,s)=>a+s.cssRules.length,0));
        // 基準版（V2101_DIR）可能已含級距樣式（例如以 v2.102 為基準），因此只要求規則數不少於基準版。
        check("[1] 基準版原有 CSS 規則全部保留（規則數不減少）", dom.rules >= oldRules, {base:oldRules, now:dom.rules, bandRules:dom.bandRules});
        await o.context.close();
      }
      await context.close(); }

    /* [2] 級距計算：界線、非 100 滿分、特殊值（直接呼叫純計算函式） */
    { const {context, page} = await newSite(browser, base, {noEnter:true});
      const r = await page.evaluate(()=>{
        const st = n=>Array.from({length:n},(_,i)=>({id:"u"+i}));
        const run = (max, vals)=>{ const scores={}; vals.forEach((v,i)=>{ if(v!=="__missing__") scores["u"+i]=v; }); return computeGradeBandSummary({maxScore:max,scores}, st(vals.length)); };
        const out = {};
        out.b100 = run(100,[100,90,89.99,80,79.99,70,69.99,60,59.99,0,89.9999999,59.999]);
        out.b50 = run(50,[50,45,44.995,40,39.995,35,34.995,30,29.995,0]);
        out.b20 = run(20,[20,18,17.998,16,15.999,14,13.998,12,11.99,0]);
        out.b70 = run(70,[63,56,49,42,41.99]);
        out.b30 = run(30,[27,24,21,18,17.99]);
        out.empty = run(100,[null,undefined,"","   ","\t","__missing__"]);
        out.allEmpty = run(100,["__missing__","__missing__","__missing__"]);
        out.noStudents = computeGradeBandSummary({maxScore:100,scores:{x:90}}, []);
        out.badScores = run(100,[-1,"-3","abc",true,false,{},[],NaN,Infinity,-Infinity,"Infinity","0x10","1e2x"]);
        out.numStrings = run(100,["85"," 72.5 ","1e2","0","90.0"]);
        out.overMax = run(100,[105,100.01,99]);
        out.badMax = [undefined,null,"","  ","abc",NaN,Infinity,0,-5,true,{},[]].map(m=>({m:String(m), r:run(m,[80,"__missing__",null,0])}));
        out.strMax = run("50",[45,25]);
        // 整數與一位小數分數的完整掃描：與精確整數運算的預期比對（不得因浮點誤差誤判，也不得四捨五入）
        let sweepMismatch = [], sweepCount = 0;
        const T=[90,80,70,60];
        for(let max=1;max<=120;max++){
          for(let s10=0;s10<=max*10;s10++){
            const score = s10/10;
            const expect = (()=>{ for(let i=0;i<4;i++){ if(s10*100 >= T[i]*max*10) return i; } return 4; })();
            const got = gradeBandIndex(score, max); sweepCount++;
            if(got!==expect && sweepMismatch.length<5) sweepMismatch.push({max,score,expect,got});
          }
        }
        out.sweep = {sweepCount, sweepMismatch};
        // 原始資料不被改寫
        const item = {maxScore:100, scores:{u0:"85", u1:-1, ghost:70}}; const before = JSON.stringify(item);
        computeGradeBandSummary(item, st(2)); out.unchanged = JSON.stringify(item)===before;
        out.pct = [formatGradeBandPercent(null), formatGradeBandPercent(2/3*100), formatGradeBandPercent(100), formatGradeBandPercent(NaN)];
        return out;
      });
      const counts = x=>x.bands.map(b=>b.count);
      const inv = x=>x.total===x.valid+x.empty+x.invalid && sumBands(x.bands)===x.valid;
      check("[2] 滿分 100：100/90/89.99/80/79.99/70/69.99/60/59.99/0 與 89.9999999、59.999", JSON.stringify(counts(r.b100))===JSON.stringify([2,3,2,2,3]) && r.b100.valid===12 && inv(r.b100), counts(r.b100));
      check("[2] 89.99、89.9999999 未被四捨五入成 90；59.99、59.999 未被進位成 60", r.b100.bands[0].count===2 && r.b100.bands[1].count===3 && r.b100.bands[4].count===3);
      check("[2] 滿分 50：50/45/44.995/40/39.995/35/34.995/30/29.995/0", JSON.stringify(counts(r.b50))===JSON.stringify([2,2,2,2,2]) && inv(r.b50), counts(r.b50));
      check("[2] 滿分 20：20/18/17.998/16/15.999/14/13.998/12/11.99/0", JSON.stringify(counts(r.b20))===JSON.stringify([2,2,2,2,2]) && inv(r.b20), counts(r.b20));
      check("[2] 滿分 70：63/56/49/42/41.99（56/70 恰為 80，歸入 80 段）", JSON.stringify(counts(r.b70))===JSON.stringify([1,1,1,1,1]), counts(r.b70));
      check("[2] 滿分 30：27/24/21/18/17.99", JSON.stringify(counts(r.b30))===JSON.stringify([1,1,1,1,1]), counts(r.b30));
      check("[2] 整數與一位小數分數全面掃描（滿分 1～120）與精確運算一致", r.sweep.sweepMismatch.length===0 && r.sweep.sweepCount===72720, r.sweep);
      check("[2] null、undefined、空字串、純空白、未填皆為未登記", r.empty.empty===6 && r.empty.valid===0 && r.empty.invalid===0, {empty:r.empty.empty, valid:r.empty.valid, invalid:r.empty.invalid});
      check("[2] 全未登記：有效 0，占比皆為「—」", r.allEmpty.valid===0 && r.allEmpty.bands.every(b=>b.percent===null) && r.pct[0]==="—", r.allEmpty);
      check("[2] 無學生：全為 0，名單外分數不計入", r.noStudents.total===0 && r.noStudents.valid===0 && r.noStudents.outsideRoster===1 && inv(r.noStudents), r.noStudents);
      check("[2] 0 分為有效分數，歸入未滿 60", r.b50.bands[4].count===2 && r.b50.valid===10 && r.numStrings.bands[4].count===1);
      check("[2] 負分、非數字、布林、物件、陣列、NaN、±Infinity、\"Infinity\"、\"0x10\" 皆為異常且不當 0", r.badScores.invalid===13 && r.badScores.valid===0 && r.badScores.bands[4].count===0, {invalid:r.badScores.invalid, reasons:r.badScores.invalidReasons});
      check("[2] 有效數字字串（\"85\"、\" 72.5 \"、\"1e2\"、\"0\"、\"90.0\"）參與統計", r.numStrings.valid===5 && JSON.stringify(counts(r.numStrings))===JSON.stringify([2,1,1,0,1]), counts(r.numStrings));
      check("[2] 超滿分計入 90 分以上並另計筆數", r.overMax.bands[0].count===3 && r.overMax.overMax===2, {bands:counts(r.overMax), overMax:r.overMax.overMax});
      check("[2] 滿分缺漏／非數字／非有限／≤0：已登記列異常、未登記仍為未登記、不默認 100", r.badMax.every(x=>x.r.max.valid===false && x.r.valid===0 && x.r.invalid===2 && x.r.empty===2 && x.r.invalidReasons.maxScore===2 && x.r.bands.every(b=>b.percent===null)), r.badMax.map(x=>({m:x.m, valid:x.r.valid, invalid:x.r.invalid, empty:x.r.empty, reason:x.r.max.reason})));
      check("[2] 滿分無效時提供原因", r.badMax.every(x=>typeof x.r.max.reason==="string" && x.r.max.reason.length>0));
      check("[2] 滿分為數字字串 \"50\" 時依 50 換算（與既有 Number(maxScore) 相容）", r.strMax.max.valid && r.strMax.max.value===50 && JSON.stringify(counts(r.strMax))===JSON.stringify([1,0,0,0,1]), counts(r.strMax));
      check("[2] 計算不改寫原始資料", r.unchanged);
      check("[2] 占比格式：— / 66.7% / 100.0% / —", JSON.stringify(r.pct)===JSON.stringify(["—","66.7%","100.0%","—"]), r.pct);
      await context.close(); }

    /* [10] 數值邊界：ChatGPT 重現案例、各門檻正好／稍低／稍高、極大與極小有限值、十進位輸入、長數字字串 */
    { const {context, page} = await newSite(browser, base, {noEnter:true});
      const r = await page.evaluate(()=>{
        const bits = new Float64Array(1), u = new BigUint64Array(bits.buffer);
        const down = x=>{ bits[0]=x; u[0]-=1n; return bits[0]; }, up = x=>{ bits[0]=x; u[0]+=1n; return bits[0]; };
        const B = ["90以上","80至未滿90","70至未滿80","60至未滿70","未滿60"];
        const cases = [];
        const add = (label, score, max, expect)=>cases.push({label, score:String(score), max:String(max), expect:B[expect], got:B[gradeBandIndex(score,max)]});
        // ChatGPT 重現案例
        add("重現 1：89.99999999999999 / 100", 89.99999999999999, 100, 1);
        add("重現 2：0 / 1e308", 0, 1e308, 4);
        add("重現 3：1e307 / 1e308（10%）", 1e307, 1e308, 4);
        // 各門檻正好／稍低（前一個 double）／稍高（下一個 double）
        // 各門檻正好／稍低（前一個 double）／稍高（下一個 double）。每列：[滿分, 90%, 80%, 70%, 60% 時的分數]
        const AT = [[100,90,80,70,60],[50,45,40,35,30],[20,18,16,14,12],[1,0.9,0.8,0.7,0.6],[1e308,9e307,8e307,7e307,6e307],[1e-300,9e-301,8e-301,7e-301,6e-301]];
        for(const [max, ...scores] of AT){
          [90,80,70,60].forEach((t,i)=>{
            const at = scores[i];
            add(`門檻 ${t}%｜滿分 ${max}｜正好 ${at}`, at, max, i);
            add(`門檻 ${t}%｜滿分 ${max}｜稍低 ${down(at)}`, down(at), max, i+1);
            add(`門檻 ${t}%｜滿分 ${max}｜稍高 ${up(at)}`, up(at), max, i);
          });
        }
        // 極大與極小有限值
        add("MAX_VALUE / MAX_VALUE", Number.MAX_VALUE, Number.MAX_VALUE, 0);
        add("0 / MAX_VALUE", 0, Number.MAX_VALUE, 4);
        add("MAX_VALUE / 1e-300（超滿分）", Number.MAX_VALUE, 1e-300, 0);
        add("9e307 / 1e308（90%）", 9e307, 1e308, 0);
        add("8.999999999999999e307 / 1e308", 8.999999999999999e307, 1e308, 1);
        add("1e308 / 1e308", 1e308, 1e308, 0);
        add("MIN_VALUE / MIN_VALUE", Number.MIN_VALUE, Number.MIN_VALUE, 0);
        add("MIN_VALUE / 1", Number.MIN_VALUE, 1, 4);
        add("0 / MIN_VALUE", 0, Number.MIN_VALUE, 4);
        add("1 / MIN_VALUE（超滿分）", 1, Number.MIN_VALUE, 0);
        add("9e-300 / 1e-299", 9e-300, 1e-299, 0);
        add("8.999999999999999e-300 / 1e-299", 8.999999999999999e-300, 1e-299, 1);
        // 十進位輸入的等值（二進位值略小於本身，仍應歸入門檻所在級距）
        add("0.7 / 1", 0.7, 1, 2); add("2.8 / 4", 2.8, 4, 2); add("4.2 / 6", 4.2, 6, 2); add("0.9 / 1", 0.9, 1, 0);
        add("1.8 / 2", 1.8, 2, 0); add("0.6 / 1", 0.6, 1, 3); add("3.6 / 4", 3.6, 4, 0); add("0.8 / 1", 0.8, 1, 1); add("56 / 70", 56, 70, 1); add("8.4 / 10.5", 8.4, 10.5, 1);
        // 數字字串以原字串判斷（不先經 Number() 捨入）
        add("\"89.999999999999999999\" / \"100\"", "89.999999999999999999", "100", 1);
        add("\"90.000000000000000001\" / \"100\"", "90.000000000000000001", "100", 0);
        add("\" 72.5 \" / \"100\"", " 72.5 ", "100", 2);
        add("\"1e2\" / \"100\"", "1e2", "100", 0);
        add("\"9e307\" / \"1e308\"", "9e307", "1e308", 0);
        add("\"1e-999999\" / \"1\"", "1e-999999", "1", 4);
        add("\"1"+"0".repeat(4000)+"\" / \"1e4000\"", "1"+"0".repeat(4000), "1e4000", 0);
        const bad = cases.filter(c=>c.got!==c.expect);
        // 統計整合：溢位、超滿分、負零、字串滿分極值
        const st = n=>Array.from({length:n},(_,i)=>({id:"u"+i}));
        const sum = (max, vals)=>{ const scores={}; vals.forEach((v,i)=>scores["u"+i]=v); return computeGradeBandSummary({maxScore:max,scores}, st(vals.length)); };
        const big = sum(1e308,[0,1e307,9e307,1e308]);
        const huge = sum(Number.MAX_VALUE,[Number.MAX_VALUE, 0]);
        const strOver = sum(100,["100.0000000000000000001", 100, "99.9999999999999999999"]);
        const negZero = sum(100,["-0", -0, "-0.5", "-0.0"]);
        const tinyMax = sum("1e-999999",[1]);
        const strBigMax = sum("1e308",["9e307","8.999999999999999e307"]);
        return {cases, bad, big, huge, strOver, negZero, tinyMax, strBigMax};
      });
      const counts = x=>x.bands.map(b=>b.count);
      check(`[10] ${r.cases.length} 個數值邊界案例全部分到正確級距`, r.bad.length===0, r.bad.slice(0,8));
      for(const c of r.cases.filter(c=>c.label.startsWith("重現"))) check(`[10] ${c.label} → ${c.expect}`, c.got===c.expect, c);
      check("[10] 統計：滿分 1e308，分數 0／1e307／9e307／1e308 → 90以上 2、未滿60 2，無超滿分", JSON.stringify(counts(r.big))===JSON.stringify([2,0,0,0,2]) && r.big.overMax===0 && r.big.valid===4, {bands:counts(r.big), overMax:r.big.overMax});
      check("[10] 統計：滿分 MAX_VALUE，分數 MAX_VALUE／0 → 90以上 1、未滿60 1，無超滿分", JSON.stringify(counts(r.huge))===JSON.stringify([1,0,0,0,1]) && r.huge.overMax===0, {bands:counts(r.huge), overMax:r.huge.overMax});
      check("[10] 超滿分以十進位判斷：\"100.0000000000000000001\" 算超滿分；100 與 \"99.9999999999999999999\" 不算", r.strOver.overMax===1 && JSON.stringify(counts(r.strOver))===JSON.stringify([3,0,0,0,0]), {bands:counts(r.strOver), overMax:r.strOver.overMax});
      check("[10] \"-0\"、-0、\"-0.0\" 為 0 分（未滿60）；\"-0.5\" 為異常（負分）", r.negZero.valid===3 && r.negZero.bands[4].count===3 && r.negZero.invalid===1 && r.negZero.invalidReasons.negative===1, {valid:r.negZero.valid, invalid:r.negZero.invalidReasons});
      check("[10] 滿分 \"1e-999999\"（JS 中為 0）不能換算，已登記列異常", r.tinyMax.max.valid===false && r.tinyMax.invalid===1, r.tinyMax.max);
      check("[10] 字串滿分 \"1e308\"：\"9e307\" → 90以上、\"8.999999999999999e307\" → 80至未滿90", JSON.stringify(counts(r.strBigMax))===JSON.stringify([1,1,0,0,0]), counts(r.strBigMax));
      await context.close(); }

    /* [3] 兩個入口、對應正確評量、不誤開編輯；名單外殘留不計入也不刪除；XSS；唯讀 */
    { const {context, page} = await newSite(browser, base);
      await page.evaluate(()=>{ gradeOverviewTerm="all"; renderGradebook(); });
      const before = await snapshot(page);
      await armWriteSpy(page);
      const overviewIds = await page.evaluate(()=>[...document.querySelectorAll("#gradebookOverview button[data-grade-band]")].map(b=>b.dataset.gradeBand));
      check("[3] 成績總覽每個評量欄位都有「級距」按鈕", JSON.stringify([...overviewIds].sort())===JSON.stringify(ITEMS.map(i=>i.id).sort()), overviewIds);
      for(const it of ITEMS){
        await overviewBtn(page, it.id).click();
        checkModalAgainst(`[3] 總覽「${it.id}」`, await modalState(page), it.id);
        await page.keyboard.press("Escape");
      }
      const xssState = await (async()=>{ await overviewBtn(page,"g-xss").click(); const m = await modalState(page); await page.keyboard.press("Escape"); return m; })();
      check("[3] 評量名稱含 HTML／事件屬性時以純文字顯示（總覽、視窗）", xssState.title===XSS_TITLE && xssState.imgInModal===0 && await page.evaluate(()=>window.__xss===undefined && document.querySelectorAll("#gradebookOverview img").length===0));
      const bad = await (async()=>{ await overviewBtn(page,"g-badscore").click(); const m = await modalState(page); await page.keyboard.press("Escape"); return m; })();
      check("[3] 異常分數評量：提示超滿分 1 筆、名單外 1 筆未計入", bad.notes.some(n=>/1 筆分數超過滿分/.test(n)) && bad.notes.some(n=>/1 筆不在目前學生名單/.test(n)), bad.notes);
      check("[3] 異常分數評量：列出異常原因", /負分/.test(bad.text) && /非數字/.test(bad.text) && /型別不符/.test(bad.text), bad.text.slice(0,400));
      const bm = await (async()=>{ await overviewBtn(page,"g-badmax").click(); const m = await modalState(page); await page.keyboard.press("Escape"); return m; })();
      check("[3] 滿分異常評量：顯示原因，原始滿分標為無效", bm.notes.some(n=>/無法換算百分制/.test(n)) && /原始滿分：無效（小於或等於 0）/.test(bm.meta), {notes:bm.notes, meta:bm.meta});
      const ghostKept = await page.evaluate(()=>{ const it=store.classes.find(c=>c.id==="cG").data.gradeItems.find(g=>g.id==="g-badscore"); return it.scores["s-ghost"]===95; });
      check("[3] 名單外殘留分數未被刪除", ghostKept);
      // 成績登記入口
      await showView(page, "register");
      const registerIds = await page.evaluate(()=>[...document.querySelectorAll("#gradebookList button[data-grade-band]")].map(b=>b.dataset.gradeBand));
      check("[3] 成績登記每個評量項目都有「級距」按鈕", JSON.stringify([...registerIds].sort())===JSON.stringify(ITEMS.map(i=>i.id).sort()), registerIds);
      for(const it of ITEMS){
        await registerBtn(page, it.id).click();
        checkModalAgainst(`[3] 登記「${it.id}」`, await modalState(page), it.id);
        await page.locator("#gradeBandCloseBtn").click();
      }
      check("[3] 成績登記卡片中的評量名稱以純文字顯示", await page.evaluate(()=>window.__xss===undefined && document.querySelectorAll("#gradebookList img").length===0));
      const calls = await writeCalls(page);
      const after = await snapshot(page);
      check("[3] 開關級距視窗未呼叫任何儲存（saveData／persistStoreSafely／commitStoreOnce／setItem 皆為 0）", Object.values(calls).every(n=>n===0), calls);
      check("[3] 查看級距前後：localStorage、修訂號記錄、記憶體中的班級資料都未變動", before.ls===after.ls && before.meta===after.meta && before.mem===after.mem && before.active===after.active, {ls:before.ls===after.ls, meta:[before.meta, after.meta], mem:before.mem===after.mem});
      // 卡片其他位置仍會開啟成績編輯（原功能保留）
      await page.locator('#gradebookList .grade-item-card', {hasText:"數學速算（滿分 20）"}).locator(".item-title").click();
      const ed = await modalState(page);
      check("[3] 點卡片其他位置仍開啟成績編輯（原功能保留），且不帶級距狀態", ed.open && ed.editor && !ed.band && !/grade-band-modal/.test(ed.modalClass) && ed.labelledby===null, ed);
      await page.locator("#modalClose").click();
      check("[3] 頁面沒有 JavaScript 錯誤", page.__errors.length===0, page.__errors);
      await context.close(); }

    /* [4] 關閉方式、Escape、焦點返回、反覆開啟、切換項目、鍵盤與焦點順序、觸控 */
    { const {context, page} = await newSite(browser, base);
      const ways = [["×", async()=>page.locator("#modalClose").click()], ["關閉按鈕", async()=>page.locator("#gradeBandCloseBtn").click()],
        ["Escape", async()=>page.keyboard.press("Escape")], ["點視窗外背景", async()=>page.mouse.click(5,5)]];
      for(const [view, btnOf] of [["overview", overviewBtn], ["register", registerBtn]]){
        await showView(page, view);
        for(const [name, close] of ways){
          await btnOf(page,"g-b50").click();
          const opened = await modalState(page);
          await close();
          const m = await modalState(page); const a = await activeBand(page);
          check(`[4] ${view==="overview"?"總覽":"登記"}：以「${name}」關閉，焦點返回原按鈕`, opened.band && !m.open && a && a.band==="g-b50" && a.source===view, {opened:opened.band, open:m.open, active:a});
        }
        // 反覆開啟、不同項目切換
        let ok = true; const seen = [];
        for(let k=0;k<3;k++) for(const id of ["g-b100","g-b20","g-none"]){
          await btnOf(page,id).click(); const m = await modalState(page); seen.push(m.title);
          ok = ok && m.band && m.title===ITEMS.find(i=>i.id===id).title && m.valid===EXPECT[id].valid;
          await page.keyboard.press("Escape");
          const a = await activeBand(page); ok = ok && a.band===id;
        }
        check(`[4] ${view==="overview"?"總覽":"登記"}：反覆開啟、切換 3 個項目 ×3 次，內容與焦點皆正確`, ok, seen);
      }
      // 鍵盤開啟與焦點順序
      await showView(page, "overview");
      await overviewBtn(page,"g-b100").focus();
      await page.keyboard.press("Enter");
      const k1 = await modalState(page); const f0 = await activeBand(page);
      check("[4] 鍵盤 Enter 可開啟級距視窗，焦點移入視窗（關閉按鈕）", k1.band && f0.id==="gradeBandCloseBtn", f0);
      const order = [];
      for(let i=0;i<5;i++){ await page.keyboard.press("Tab"); order.push(await page.evaluate(()=>{ const a=document.activeElement; return a.id || a.tagName.toLowerCase()+"."+(a.className||""); })); }
      check("[4] Tab 焦點在視窗內循環：× → 內容捲動區 → 計算規則 → 關閉 → ×", JSON.stringify(order)===JSON.stringify(["modalClose","div.grade-band-scroll","summary.","gradeBandCloseBtn","modalClose"]), order);
      await page.keyboard.press("Shift+Tab");
      check("[4] Shift+Tab 由第一個元素回到最後一個（關閉）", (await activeBand(page)).id==="gradeBandCloseBtn");
      await page.keyboard.press("Space");
      check("[4] 鍵盤 Space 可按下關閉，焦點返回原按鈕", !(await modalState(page)).open && (await activeBand(page)).band==="g-b100");
      // Escape 只對級距視窗生效：其他共用視窗維持原行為（v2.101 共用視窗沒有 Escape 關閉）
      await page.evaluate(()=>openGradeExcelExport());
      await page.keyboard.press("Escape");
      const ex = await modalState(page);
      check("[4] 其他共用視窗（Excel 匯出）不受影響：Escape 不關閉、無級距樣式與標記", ex.open && !ex.band && !/grade-band-modal/.test(ex.modalClass) && ex.labelledby===null, ex);
      await page.locator("#modalClose").click();
      await context.close();
      // 觸控
      const t = await newSite(browser, base, {touch:true, viewport:{width:390,height:844}});
      await t.page.locator('#gradebookOverview button[data-grade-band="g-b20"]').tap();
      const tm = await modalState(t.page);
      await t.page.locator("#gradeBandCloseBtn").tap();
      await t.page.locator('[data-grade-view="register"]').tap();
      await t.page.locator('#gradebookList button[data-grade-band="g-b100"]').tap();
      const tr = await modalState(t.page);
      check("[4] 觸控（tap）：總覽與登記入口皆開啟正確級距、未誤開編輯", tm.band && tm.title===ITEMS[2].title && tr.band && !tr.editor && tr.title===ITEMS[0].title, {tm:tm.title, tr:tr.title, editor:tr.editor});
      await t.context.close(); }

    /* [5] 科目、期中／期末篩選與停用區段 */
    { const {context, page} = await newSite(browser, base);
      const idsIn = sel => page.evaluate(s=>[...document.querySelectorAll(s+" button[data-grade-band]")].map(b=>b.dataset.gradeBand).sort(), sel);
      await page.selectOption("#gradeSubjectFilter","sub-math");
      const mathOverview = await idsIn("#gradebookOverview");
      check("[5] 科目篩選（數學）：總覽只出現數學評量的按鈕", JSON.stringify(mathOverview)===JSON.stringify(ITEMS.filter(i=>i.subjectId==="sub-math").map(i=>i.id).sort()), mathOverview);
      await overviewBtn(page,"g-b20").click(); const m1 = await modalState(page); await page.keyboard.press("Escape");
      check("[5] 篩選後按鈕仍對應正確評量", m1.title===ITEMS[2].title && m1.valid===EXPECT["g-b20"].valid);
      await page.selectOption("#gradeSubjectFilter","");
      check("[5] 科目篩選（未分類）：只出現未分類評量", JSON.stringify(await idsIn("#gradebookOverview"))===JSON.stringify(["g-long"]));
      await page.selectOption("#gradeSubjectFilter","all");
      await page.locator('[data-grade-term-view="midterm"]').click();
      const mid = await idsIn("#gradebookOverview");
      check("[5] 期中篩選：總覽只出現期中評量的按鈕", JSON.stringify(mid)===JSON.stringify(ITEMS.filter(i=>i.gradeTerm==="midterm").map(i=>i.id).sort()), mid);
      await overviewBtn(page,"g-none").click(); const m2 = await modalState(page); await page.keyboard.press("Escape");
      check("[5] 期中篩選下按鈕對應正確評量，視窗顯示區段", m2.title==="全未登記評量" && /區段：期中/.test(m2.meta), m2.meta);
      await page.locator('[data-grade-term-view="final"]').click();
      const fin = await idsIn("#gradebookOverview");
      check("[5] 期末篩選：總覽只出現期末評量的按鈕", JSON.stringify(fin)===JSON.stringify(ITEMS.filter(i=>i.gradeTerm==="final").map(i=>i.id).sort()), fin);
      await showView(page, "register");
      check("[5] 成績登記不受期中／期末篩選影響，列出全部評量的按鈕", (await idsIn("#gradebookList")).length===ITEMS.length);
      // 停用區段（這一步透過設定視窗正常儲存）
      await showView(page, "overview");
      await page.locator("#gradeTermSettingsBtn").click();
      await page.locator("#gradeTermsEnabledInput").uncheck();
      await page.locator("#gradeTermSettingsForm").evaluate(f=>f.requestSubmit());
      await flush(page);
      const dis = await page.evaluate(()=>({tabsHidden:document.getElementById("gradeOverviewTermTabs").hidden, enabled:data.settings.gradeTermsEnabled, ids:[...document.querySelectorAll("#gradebookOverview button[data-grade-band]")].map(b=>b.dataset.gradeBand).length}));
      check("[5] 停用區段後：區段切換隱藏，總覽列出全部評量的按鈕", dis.tabsHidden && dis.enabled===false && dis.ids===ITEMS.length, dis);
      await overviewBtn(page,"g-b50").click(); const m3 = await modalState(page); await page.keyboard.press("Escape");
      check("[5] 停用區段後：按鈕對應正確評量，視窗不顯示區段", m3.title===ITEMS[1].title && !/區段：/.test(m3.meta) && m3.valid===EXPECT["g-b50"].valid, m3.meta);
      const kept = await page.evaluate(()=>data.gradeItems.find(g=>g.id==="g-b50").gradeTerm);
      check("[5] 停用區段不清除評量的區段歸屬", kept==="final", kept);
      check("[5] 頁面沒有 JavaScript 錯誤", page.__errors.length===0, page.__errors);
      await context.close(); }

    /* [6] 版面：390／768／1024／1365px；長名稱換行與捲動 */
    const widthResult = {};
    for(const [label, root] of [["v2.102", base], ...(oldBase?[["v2.101", oldBase]]:[])]){
      for(const w of [390,768,1024,1365]){
        const {context, page} = await newSite(browser, root, {viewport:{width:w,height:860}});
        // 整頁是否真的能水平捲動：嘗試捲到最右，再讀 scrollX（內層表格自己的捲動不算）。
      const m = async()=>page.evaluate(()=>{ window.scrollTo(99999, window.scrollY); const r={doc:document.documentElement.scrollWidth, body:document.body.scrollWidth, inner:window.innerWidth, scrollX:window.scrollX}; window.scrollTo(0, window.scrollY); return r; });
        const r = {overview: await m()};
        await showView(page,"register"); r.register = await m();
        if(label==="v2.102"){
          await registerBtn(page,"g-long").click();
          r.modal = await m();
          r.modalBox = await page.evaluate(()=>{ const d=document.querySelector("#modalBackdrop .modal"), t=document.querySelector(".grade-band-title"), sc=document.querySelector(".grade-band-scroll");
            const rect=d.getBoundingClientRect(); return {left:rect.left, right:rect.right, inner:innerWidth, dialogOverflowX:d.scrollWidth-d.clientWidth, titleLines:Math.round(t.getBoundingClientRect().height/parseFloat(getComputedStyle(t).lineHeight)), titleOverflow:t.scrollWidth-t.clientWidth,
              scrollable:getComputedStyle(sc).overflowY, scH:sc.scrollHeight, scClient:sc.clientHeight}; });
          await page.screenshot({path:path.join(TMP,`band-modal-${w}.png`)});
          await page.keyboard.press("Escape");
          await showView(page,"overview");
          r.overviewTableScroll = await page.evaluate(()=>{ const s=document.querySelector(".grade-overview-scroll"); return {overflowX:getComputedStyle(s).overflowX, inner:s.scrollWidth>s.clientWidth}; });
        }
        widthResult[`${label}-${w}`] = r;
        await context.close();
      }
    }
    for(const w of [390,768,1024,1365]){
      const n = widthResult[`v2.102-${w}`], o = widthResult[`v2.101-${w}`];
      const noPageScroll = x=>x.doc<=x.inner && x.scrollX===0;
      const noNew = o ? ["overview","register"].every(k=>n[k].doc<=Math.max(n[k].inner,o[k].doc) && n[k].body<=Math.max(n[k].inner,o[k].body)) : true;
      check(`[6] ${w}px：總覽、登記、級距視窗開啟時，整頁皆無法水平捲動`, noPageScroll(n.overview) && noPageScroll(n.register) && noPageScroll(n.modal), {overview:n.overview, register:n.register, modal:n.modal});
      if(o) check(`[6] ${w}px：與 v2.101 同資料比較，沒有新增的水平溢出`, noNew, {v2102:{overview:n.overview, register:n.register}, v2101:{overview:o.overview, register:o.register}});
      check(`[6] ${w}px：視窗在畫面內，長名稱換行（無水平溢出），內容區可捲動`, n.modalBox.left>=0 && n.modalBox.right<=n.modalBox.inner && n.modalBox.dialogOverflowX<=0 && n.modalBox.titleOverflow<=0 && n.modalBox.titleLines>=2 && n.modalBox.scrollable==="auto", n.modalBox);
      check(`[6] ${w}px：成績總覽表格保留表格內捲動`, n.overviewTableScroll.overflowX==="auto", n.overviewTableScroll);
    }

    /* [7] 舊格式相容：V1 舊鍵資料遷移後，級距可用 */
    { const v1 = {...classData(), class:{name:"虛構V1舊班"}, gradeItems:[{id:"g-v1",subjectId:"sub-math",title:"V1舊格式評量",date:"2025-05-01",maxScore:"100",scores:{s01:"95",s02:"58",s03:"",s04:" "}}]};
      delete v1.settings;
      const {context, page} = await newSite(browser, base, {legacyV1:JSON.stringify(v1)});
      const loaded = await page.evaluate(()=>({n:store.classes.length, name:store.classes[0].name, items:data.gradeItems.length}));
      check("[7] V1 舊鍵資料可讀取並進入成績頁", loaded.n===1 && loaded.name==="虛構V1舊班" && loaded.items===1, loaded);
      const before = await snapshot(page); await armWriteSpy(page);
      await overviewBtn(page,"g-v1").click(); const m = await modalState(page); await page.keyboard.press("Escape");
      check("[7] V1 舊格式評量（字串分數與滿分）級距正確", m.band && m.valid===2 && m.empty===8 && JSON.stringify(m.bands.map(b=>b.count))===JSON.stringify([1,0,0,0,1]), m);
      const after = await snapshot(page);
      check("[7] 舊格式資料查看級距前後未變動、未寫入", before.ls===after.ls && before.mem===after.mem && Object.values(await writeCalls(page)).every(n=>n===0));
      await context.close(); }
    { // v2.100 格式（無 syncRevision）：查看級距不觸發修訂號認領寫入
      const {context, page} = await newSite(browser, base, {noEnter:true});
      const before = await snapshot(page); await armWriteSpy(page);
      await page.evaluate(()=>{ const it=store.classes[0].data.gradeItems[0]; window.__r=computeGradeBandSummary(it, store.classes[0].data.students); });
      const after = await snapshot(page);
      check("[7] v2.100 格式資料（無修訂號）：計算級距不寫入、不取得修訂號", before.ls===after.ls && before.meta===after.meta && !/syncRevision/.test(after.ls) && Object.values(await writeCalls(page)).every(n=>n===0), {meta:after.meta});
      await context.close(); }

    /* [8] Excel 匯出：完整班級與目前畫面 */
    async function exportXlsx(root, mode, tag){
      const {context, page} = await newSite(browser, root);
      if(mode==="current"){ await page.selectOption("#gradeSubjectFilter","sub-chinese"); await page.locator('[data-grade-term-view="final"]').click(); }
      await page.locator("#exportGradeExcelBtn").click();
      const [dl] = await Promise.all([page.waitForEvent("download"), page.locator(mode==="all"?'button:has-text("下載完整 Excel")':'button:has-text("下載目前畫面 Excel")').click()]);
      const file = path.join(TMP, `${tag}-${mode}.xlsx`); await dl.saveAs(file);
      await context.close();
      const list = execFileSync("unzip",["-Z1",file]).toString().trim().split("\n");
      const read = name => execFileSync("unzip",["-p",file,name.replace(/\[/g,"[[]")]).toString();
      return {file, list, read, name:dl.suggestedFilename()};
    }
    for(const mode of ["all","current"]){
      const x = await exportXlsx(base, mode, "v2102");
      const wb = x.read("xl/workbook.xml");
      const sheets = [...wb.matchAll(/<sheet name="([^"]+)"/g)].map(m=>m[1]);
      check(`[8] Excel（${mode==="all"?"完整班級":"目前畫面"}）可下載、可解壓並含工作表`, x.list.includes("xl/workbook.xml") && sheets.length>=3, {name:x.name, sheets});
      if(mode==="all") check("[8] 完整班級：含全部、期中、期末、評量項目、逐筆分數工作表", ["全部成績","期中成績","期末成績","評量項目","逐筆分數"].every(n=>sheets.includes(n)), sheets);
      const allXml = x.list.filter(n=>/^xl\/worksheets\/sheet\d+\.xml$/.test(n)).map(n=>x.read(n)).join("\n");
      check(`[8] Excel（${mode==="all"?"完整班級":"目前畫面"}）：含平均公式`, /<f>[^<]+<\/f>/.test(allXml), allXml.match(/<f>[^<]{0,80}/)?.[0]);
      check(`[8] Excel（${mode==="all"?"完整班級":"目前畫面"}）：滿分 50 的評量以原始滿分呈現`, /滿分 50/.test(allXml), null);
      if(mode==="current") check("[8] 目前畫面（國語、期末）：只含該範圍評量", /國語小考（滿分 50）/.test(allXml) && !/數學單元一/.test(allXml), null);
      if(V2101_DIR){
        const o = await exportXlsx(oldBase, mode, "v2101");
        // 只比對儲存格資料（sheetData），確認匯出的分數、空白、滿分與平均公式沒有回歸。
        // 這不是格式正確的依據：XLSX 結構正確性改由 tests/xlsx-structure.test.js（Open XML SDK 驗證與結構檢查）判定。
        const sheetData = xml=>(xml.match(/<sheetData>[\s\S]*<\/sheetData>/)||[""])[0];
        const sheets = list=>list.filter(n=>/^xl\/worksheets\/sheet\d+\.xml$/.test(n));
        const same = JSON.stringify(sheets(x.list))===JSON.stringify(sheets(o.list)) && sheets(x.list).every(n=>sheetData(x.read(n))===sheetData(o.read(n)));
        check(`[8] Excel（${mode==="all"?"完整班級":"目前畫面"}）儲存格資料（分數、空白、非 100 滿分、平均公式）與基準版相同（內容回歸檢查，非格式正確依據）`, same, {new:sheets(x.list), base:sheets(o.list)});
      }
    }

    /* [9] 與 v2.101 比較：資料安全與匯入核心函式原文未變 */
    if(V2101_DIR){
      const oldJs = fs.readFileSync(path.join(V2101_DIR,"app.js"),"utf8"), newJs = fs.readFileSync(path.join(SITE_DIR,"app.js"),"utf8");
      const fnSrc = (js, name)=>{ const re = new RegExp(`^(?:async )?function ${name}\\(`, "m"); const m = re.exec(js); if(!m) return null;
        const rest = js.slice(m.index); const end = rest.slice(1).search(/\n(?:async function |function |const |let |var |\/\/ |document\.|window\.)/); return end<0?rest:rest.slice(0,end+1); };
      const SAFETY = ["loadStore","normalizeData","showDataStorageWarning","downloadCurrentTabDataBackup","storeRawForRevision","recordPersistFailure","showSyncUnavailableNotice","markSyncUnavailable",
        "contentDigest","adoptRevisionForLegacyData","readSyncMeta","openSyncDb","commitStoreWithoutCoordination","syncMetaTransaction","isWriterTabClosed","commitStoreOnce","sameReservation",
        "handleUnfinishedReservation","continueFromThisPageAfterUnfinishedWrite","persistStoreSafely","isCrossTabCoordinationAvailable","saveData","commitClassImport","classImportFailureMessage",
        "isMultiClassRescueFile","classImportConfirmMessage","finishClassImport","exportClassBackup","isClassBackupData","importClassBackup","exportBackup","importBackup","persistActiveClass","enterClass","leaveClass",
        // v2.103 刻意修改 gradeExcelSheetXml（節點順序）、gradeExcelWorkbook（_xlnm._FilterDatabase）與
        // exportGradeExcel（公式長度保護），不列入原文比對；其行為由 tests/xlsx-structure.test.js 驗證。
        "gradeExcelBuildSheets","gradeExcelOverviewSheet","gradeExcelCell","gradeExcelXmlText","gradeExcelZip","gradeExcelStylesXml","gradeStats","gradeValues","gradeStudentAverage","openGradeItem","saveGradeEntries","closeModal"];
      const changed = SAFETY.filter(n=>{ const a=fnSrc(oldJs,n), b=fnSrc(newJs,n); return a===null || b===null || a!==b; });
      check(`[9] ${SAFETY.length} 個資料安全／匯入／Excel 資料／成績編輯函式原文與基準版（V2101_DIR）完全相同`, changed.length===0, changed);
      const consts = ["STORAGE_KEY","LEGACY_STORAGE_KEY","SYNC_DB_NAME","SYNC_STORE_NAME","SYNC_DB_OPEN_LIMIT_MS","TAB_LOCK_PREFIX","UNFINISHED_NOTICE_KEY","LEGACY_NOTICE_KEY"];
      const constLine = (js,n)=>(js.match(new RegExp(`^const ${n} = .*$`,"m"))||[null])[0];
      const cChanged = consts.filter(n=>constLine(oldJs,n)===null || constLine(oldJs,n)!==constLine(newJs,n));
      check("[9] 儲存鍵與協調常數未變", cChanged.length===0, cChanged);
      const listener = js=>(js.match(/window\.addEventListener\("storage"[\s\S]*?\n\}\);/)||[null])[0];
      check("[9] 跨分頁 storage 事件監聽未變", listener(oldJs)!==null && listener(oldJs)===listener(newJs));
    }else{
      console.log("SKIP  [9] 未提供 V2101_DIR，略過與 v2.101 的原文比對");
    }
  }finally{
    await browser.close(); server.close(); if(oldServer) oldServer.close();
  }
  const failed = results.filter(r=>!r.ok);
  console.log(`\n截圖與匯出檔：${TMP}`);
  console.log(`${results.length-failed.length}/${results.length} passed`);
  process.exit(failed.length?1:0);
}
run().catch(e=>{ console.error(e); process.exit(2); });
