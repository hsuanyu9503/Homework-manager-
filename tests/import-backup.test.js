#!/usr/bin/env node
/*
 * 單班級備份匯入：儲存確認與失敗保護 — 回歸測試（僅供開發測試，正式網站不載入）。
 *
 * 執行方式（於 repository 根目錄）：
 *   node tests/import-backup.test.js
 *
 * - 以 127.0.0.1 隨機埠啟動獨立靜態伺服器（與正式 GitHub Pages 不同來源，localStorage 不共用）。
 * - 每個案例使用新的、無痕的 Playwright browser context（臨時設定檔），測完即丟棄。
 * - 全部資料皆為虛構。容量不足以攔截 Storage.prototype.setItem 拋出 QuotaExceededError 模擬，不會填滿真實裝置。
 * - 跨分頁競爭：[9] 不等待儲存同步、新分頁剛寫入就從舊分頁匯入（真實競爭，重複多次）；
 *   [10] 以測試掛勾讓舊分頁讀到「尚未同步的舊值」並收不到 storage 事件（決定性重現）；
 *   [11] 兩個分頁同時通過寫入前檢查。STRESS 環境變數可調整重複次數（預設 12）。
 * - 需要可 require('playwright') 的環境（Chromium）。
 */
"use strict";
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const STORAGE_KEY = "homeworkTrackerDataV2";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hm-import-test-"));

/* ---------------- 虛構測試資料 ---------------- */
const FUTURE = "2099-01-05";
function classData(name, tag){
  return {
    version:1,
    class:{name},
    students:[
      {id:`s1-${tag}`,number:1,name:`${tag}學生甲`,tags:[]},
      {id:`s2-${tag}`,number:2,name:`${tag}學生乙`,tags:[]}
    ],
    assignments:[{id:`a1-${tag}`,title:`${tag}作業一`,date:FUTURE,createdAt:"2099-01-01T00:00:00.000Z"}],
    records:[
      {assignmentId:`a1-${tag}`,studentId:`s1-${tag}`,status:"completed",note:`${tag}備註甲`},
      {assignmentId:`a1-${tag}`,studentId:`s2-${tag}`,status:"missing",note:""}
    ],
    subjects:[{id:"sub-math",name:"數學"}],
    gradeItems:[
      // 未分配 / 期中 / 期末；甲零分、乙未登記
      {id:`g0-${tag}`,name:`${tag}小考`,subjectId:"sub-math",gradeTerm:"",scores:{[`s1-${tag}`]:0}},
      {id:`g1-${tag}`,name:`${tag}期中考`,subjectId:"sub-math",gradeTerm:"midterm",scores:{[`s1-${tag}`]:88,[`s2-${tag}`]:0}},
      {id:`g2-${tag}`,name:`${tag}期末考`,subjectId:"sub-math",gradeTerm:"final",scores:{[`s2-${tag}`]:95}}
    ],
    scores:{[`s1-${tag}`]:0},
    settings:{gradeTermsEnabled:true}
  };
}
const SEED = {
  version:2,
  classes:[
    {id:"cA",name:"A班（原值）",createdAt:"2026-01-01T00:00:00.000Z",data:classData("A班（原值）","原A")},
    {id:"cB",name:"B班（原值）",createdAt:"2026-01-01T00:00:00.000Z",data:classData("B班（原值）","原B")}
  ]
};
const IMPORT_DATA = classData("A班（匯入檔）","匯入");
const FILES = {
  envelope: JSON.stringify({app:"classroom-manager",version:"2.100",backupDate:"2026-11-01T00:00:00.000Z",className:"A班（匯入檔）",data:IMPORT_DATA},null,2),
  flat: JSON.stringify({...IMPORT_DATA,backupDate:"2026-11-01T00:00:00.000Z"},null,2),
  corrupt: '{"students":[ 這不是 JSON',
  multi: JSON.stringify({app:"classroom-manager",version:"2.100",backupDate:"2026-11-01T00:00:00.000Z",
    classes:[{id:"cA",name:"A班（救援檔）",data:classData("A班（救援檔）","救援A")},{id:"cB",name:"B班（救援檔）",data:classData("B班（救援檔）","救援B")}]},null,2)
};
const FILE_PATHS = Object.fromEntries(Object.entries(FILES).map(([k,v])=>{
  const p = path.join(TMP, `fixture-${k}.json`); fs.writeFileSync(p, v); return [k,p];
}));

/* ---------------- 靜態伺服器 ---------------- */
const TYPES = {".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"};
function startServer(){
  const server = http.createServer((req,res)=>{
    const urlPath = decodeURIComponent(new URL(req.url,"http://x").pathname);
    const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/,"");
    if(!["index.html","app.js","style.css"].includes(rel)){ res.writeHead(404); return res.end(); }
    res.writeHead(200,{"Content-Type":TYPES[path.extname(rel)]||"application/octet-stream"});
    fs.createReadStream(path.join(ROOT,rel)).pipe(res);
  });
  return new Promise(r=>server.listen(0,"127.0.0.1",()=>r(server)));
}

/* ---------------- 頁面工具 ---------------- */
const STRESS = Math.max(1, Number(process.env.STRESS)||12);
const INIT = (opts) => {
  if(opts && opts.noIdb) Object.defineProperty(window, "indexedDB", {value:undefined, configurable:true});
  // 模擬 indexedDB.open() 永不回應（部分 Safari 版本的已知問題）
  if(opts && opts.idbHang) Object.defineProperty(window, "indexedDB", {value:{open(){ return {}; }}, configurable:true});
  // 模擬「另一分頁的寫入尚未同步到本分頁」：設定 window.__staleView 後，getItem 回傳凍結的舊值，
  // 且本分頁收不到 storage 事件。只在測試中使用，用來決定性重現跨分頁讀取延遲。
  const origGet = Storage.prototype.getItem;
  window.__realGetItem = k => origGet.call(localStorage,k);
  Storage.prototype.getItem = function(k){
    if(window.__staleView && Object.prototype.hasOwnProperty.call(window.__staleView,k)) return window.__staleView[k];
    return origGet.call(this,k);
  };
  window.addEventListener("storage", e=>{ if(window.__staleView) e.stopImmediatePropagation(); }, true);
  // 模擬 IndexedDB 協調記錄寫入失敗：window.__metaPutFault = {when:"afterSetItem"|"beforeSetItem", how:"throw"|"abort"}。
  // afterSetItem：本次設定後已有 localStorage.setItem 成功，才讓 meta.put 拋錯或中止交易。
  window.__setItemCount = 0;
  const origSetForCount = Storage.prototype.setItem;
  Storage.prototype.setItem = function(k,v){ const r = origSetForCount.call(this,k,v); window.__setItemCount++; return r; };
  if(typeof IDBObjectStore!=="undefined"){
    const origPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key){
      const f = window.__metaPutFault;
      if(f && this.name==="meta"){
        const after = window.__setItemCount > f.armedAt;
        if((f.when==="afterSetItem" && after) || (f.when==="beforeSetItem" && !after)){
          window.__metaPutFaultHits = (window.__metaPutFaultHits||0)+1;
          if(f.how==="throw") throw new DOMException("模擬 meta.put 失敗","UnknownError");
          const r = origPut.call(this,value,key); this.transaction.abort(); return r;
        }
      }
      return origPut.call(this,value,key);
    };
  }
  // 模擬容量不足：僅在測試設定旗標時讓寫入失敗。
  const orig = Storage.prototype.setItem;
  Storage.prototype.setItem = function(k,v){
    if(window.__simulateQuota) throw new DOMException("模擬容量不足","QuotaExceededError");
    return orig.call(this,k,v);
  };
  // 模擬讀檔延遲：測試設定 window.__readGate（Promise）時，讀檔要等它 resolve 才完成。
  const origText = Blob.prototype.text;
  Blob.prototype.text = function(){ const go=()=>origText.call(this); if(window.__readGate){ window.__readStarted=true; return window.__readGate.then(go); } return go(); };
  const origReadAsText = FileReader.prototype.readAsText;
  FileReader.prototype.readAsText = function(...args){
    if(window.__readGate){ window.__readStarted=true; window.__readGate.then(()=>origReadAsText.apply(this,args)); return; }
    return origReadAsText.apply(this,args);
  };
  window.__toasts = [];
  document.addEventListener("DOMContentLoaded",()=>{
    const el = document.getElementById("toast");
    if(el) new MutationObserver(()=>{ if(el.textContent) window.__toasts.push(el.textContent); })
      .observe(el,{childList:true,characterData:true,subtree:true});
  });
};

async function openPage(context, base, dialogPolicy){
  const page = await context.newPage();
  page.__dialogs = [];
  page.__policy = dialogPolicy || {confirm:true};
  page.on("dialog", async d=>{
    const c = page.__policy.confirm;
    const accepted = d.type()!=="confirm" || (typeof c==="function" ? c(d.message()) : c);
    page.__dialogs.push({type:d.type(),message:d.message(),accepted});
    return accepted ? d.accept() : d.dismiss();
  });
  await page.goto(base);
  return page;
}
async function newContext(browser, base, opts={}){
  const context = await browser.newContext({acceptDownloads:true});
  await context.addInitScript(INIT, opts);
  const page = await openPage(context, base);
  await page.evaluate(([k,v])=>localStorage.setItem(k,v),[STORAGE_KEY,JSON.stringify(SEED)]);
  await page.reload();
  return {context,page};
}
// 先等本分頁排隊中的寫入完成（v2.101 起寫入為非同步），再讀實際儲存內容。
const flush = page => page.evaluate(async()=>{ try{ await __commitTail; }catch(e){} });
const readStore = async page => { await flush(page); return page.evaluate(k=>JSON.parse(window.__realGetItem(k)),STORAGE_KEY); };
const clsOf = (st,id) => st.classes.find(c=>c.id===id);
const toasts = page => page.evaluate(()=>window.__toasts.slice());

// 等到匯入流程有結果（alert、toast、或確認被取消）再繼續，不依賴固定延遲。
async function settle(page, timeout=10000){
  const start = Date.now();
  while(Date.now()-start < timeout){
    const t = await page.evaluate(()=>window.__toasts.length);
    if(t || page.__dialogs.some(d=>d.type==="alert" || (d.type==="confirm" && !d.accepted))) break;
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(100);
}
// Chromium 跨分頁的 localStorage 同步是非同步的：另一分頁剛寫入的值，可能要稍後才讀得到。
// 驗收情境是「新分頁較早已儲存」，因此先等舊分頁讀得到新分頁的寫入，再操作舊分頁。
// （兩分頁在毫秒內先後寫入時，既有防覆寫機制偵測不到；基準 2ab11a3 即如此，另案處理。）
async function waitUntilVisible(page, raw){
  await page.waitForFunction(([k,v])=>localStorage.getItem(k)===v, [STORAGE_KEY, raw]);
}
async function importVia(page, entry, fileKey){
  page.__dialogs.length = 0;
  await page.evaluate(()=>{ window.__toasts.length = 0; });
  if(entry==="home"){
    await page.evaluate(()=>{ if(activeClassId) leaveClass(); openClassSettings("cA"); });
    await page.setInputFiles('#modalBody input[type=file]', FILE_PATHS[fileKey]);
  }else{
    await page.evaluate(()=>{ if(activeClassId!=="cA") enterClass("cA"); setPage("settings"); });
    await page.setInputFiles('#importInput', FILE_PATHS[fileKey]);
  }
  await settle(page);
}
async function visibleText(page, entry){
  return entry==="home"
    ? page.evaluate(()=>document.getElementById("classCardList").innerText + "\n" + document.getElementById("modalBody").innerHTML)
    : page.evaluate(()=>document.getElementById("classNameInput").value + "\n" + document.getElementById("studentRosterInput").value + "\n" + (document.querySelector(".workspace-title, #activeClassName, header")?.innerText||""));
}
const SUCCESS_RE = /匯入完成|已匯入/;

/* ---------------- 斷言 ---------------- */
const results = [];
function check(name, cond, detail){
  results.push({name, ok:!!cond, detail});
  console.log(`${cond?"PASS":"FAIL"}  ${name}${!cond&&detail?`\n      ${typeof detail==="string"?detail:JSON.stringify(detail)}`:""}`);
}
function assertImportedA(st, label, expectedName){
  const a = clsOf(st,"cA"), d = a.data;
  check(`${label}：班名`, a.name===expectedName, a.name);
  check(`${label}：學生`, JSON.stringify(d.students.map(s=>[s.id,s.number,s.name]))===JSON.stringify(IMPORT_DATA.students.map(s=>[s.id,s.number,s.name])), d.students);
  check(`${label}：作業`, JSON.stringify(d.assignments)===JSON.stringify(IMPORT_DATA.assignments), d.assignments);
  check(`${label}：逐生紀錄`, JSON.stringify(d.records)===JSON.stringify(IMPORT_DATA.records), d.records);
  const terms = Object.fromEntries(d.gradeItems.map(g=>[g.id,g.gradeTerm]));
  check(`${label}：未分配／期中／期末`, terms["g0-匯入"]===""&&terms["g1-匯入"]==="midterm"&&terms["g2-匯入"]==="final", terms);
  const g0 = d.gradeItems.find(g=>g.id==="g0-匯入"), g2 = d.gradeItems.find(g=>g.id==="g2-匯入");
  check(`${label}：零分與未登記可區分`,
    g0.scores["s1-匯入"]===0 && !("s2-匯入" in g0.scores) && !("s1-匯入" in g2.scores) && g2.scores["s2-匯入"]===95 &&
    d.scores["s1-匯入"]===0 && !("s2-匯入" in d.scores), {g0:g0.scores,g2:g2.scores,scores:d.scores});
}
function assertUnchanged(st, label){
  check(`${label}：A 班維持原值`, JSON.stringify(clsOf(st,"cA").data.students)===JSON.stringify(clsOf(SEED_LOADED,"cA").data.students) && clsOf(st,"cA").name===clsOf(SEED_LOADED,"cA").name && JSON.stringify(clsOf(st,"cA").data.gradeItems)===JSON.stringify(clsOf(SEED_LOADED,"cA").data.gradeItems), clsOf(st,"cA").name);
  check(`${label}：B 班維持原值`, JSON.stringify(clsOf(st,"cB"))===JSON.stringify(clsOf(SEED_LOADED,"cB")));
}
let SEED_LOADED;

/* ---------------- 案例 ---------------- */
async function run(){
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}/index.html`;
  // 未設定 UTF-8 locale 時 Chromium 會把中文下載檔名改成 "download"，與程式無關。
  const browser = await chromium.launch({env:{...process.env, LANG:process.env.LANG && /UTF-?8/i.test(process.env.LANG) ? process.env.LANG : "C.UTF-8"}});
  try{
    // 基準：載入後經正規化的種子資料（作為「原值」比較基準）
    { const {context,page} = await newContext(browser,base);
      await page.evaluate(()=>{ enterClass("cA"); leaveClass(); enterClass("cB"); leaveClass(); });
      SEED_LOADED = await readStore(page); await context.close(); }

    // 驗收 1：兩入口 × 兩格式
    for(const entry of ["home","settings"]){
      for(const fmt of ["envelope","flat"]){
        const label = `[1] ${entry==="home"?"班級首頁":"班內設定"} × ${fmt==="envelope"?"封裝":"攤平"}`;
        const {context,page} = await newContext(browser,base);
        await page.evaluate(()=>{ enterClass("cB"); leaveClass(); }); // 讓 B 班經過一般正規化
        const bBefore = clsOf(await readStore(page),"cB");
        await importVia(page, entry, fmt);
        const t = await toasts(page);
        check(`${label}：顯示成功`, t.some(x=>SUCCESS_RE.test(x)), {toasts:t,dialogs:page.__dialogs});
        const conf = page.__dialogs.filter(d=>d.type==="confirm").map(d=>d.message).join("\n");
        check(`${label}：確認訊息分列目標班級與備份班級`, /即將被取代的目標班級：A班（原值）/.test(conf) && /備份檔中的班級：A班（匯入檔）/.test(conf), conf);
        await page.reload();
        const st = await readStore(page);
        // 首頁入口沿用 className；班內設定沿用備份內 class.name（既有行為）；攤平格式於首頁入口不改班名（既有行為）
        const expectedName = (entry==="home" && fmt==="flat") ? "A班（原值）" : "A班（匯入檔）";
        assertImportedA(st, label, expectedName);
        check(`${label}：首頁班名與班內名稱一致`, clsOf(st,"cA").data.class.name===clsOf(st,"cA").name, {name:clsOf(st,"cA").name, inner:clsOf(st,"cA").data.class.name});
        check(`${label}：B 班維持原值`, JSON.stringify(clsOf(st,"cB"))===JSON.stringify(bBefore));
        await context.close();
      }
    }

    // 驗收 2：舊分頁不能覆寫較新資料
    for(const entry of ["home","settings"]){
      const label = `[2] ${entry==="home"?"班級首頁":"班內設定"} 舊分頁匯入`;
      const {context,page:oldPage} = await newContext(browser,base);
      // 舊分頁先有一筆可辨識的本頁修改（成功儲存），之後才由新分頁製造衝突
      const oldSaved = await oldPage.evaluate(()=>{ enterClass("cA"); data.students[1].name="舊分頁修改學生乙"; return saveData(); });
      check(`${label}：舊分頁本頁修改已儲存`, oldSaved===true);
      if(entry==="settings") await oldPage.evaluate(()=>setPage("settings"));
      else await oldPage.evaluate(()=>leaveClass());
      const newPage = await openPage(context, base);
      await newPage.evaluate(async()=>{ enterClass("cA"); data.class.name="A班（新分頁修改）"; data.students[0].name="新分頁修改學生"; data.students[1].name="新分頁修改學生乙"; await saveData(); });
      const newSaved = await readStore(newPage);
      await waitUntilVisible(oldPage, JSON.stringify(newSaved));
      check(`${label}：新分頁已寫入`, clsOf(newSaved,"cA").name==="A班（新分頁修改）");
      await importVia(oldPage, entry, "envelope");
      const t = await toasts(oldPage);
      const alerts = oldPage.__dialogs.filter(d=>d.type==="alert").map(d=>d.message);
      check(`${label}：提示衝突`, alerts.some(m=>/其他分頁/.test(m)) && alerts.some(m=>/匯入未完成|沒有寫入|未寫入/.test(m)), alerts);
      check(`${label}：提示說明救援檔為「本次匯入前，本頁保留的資料」`, alerts.some(m=>/本次匯入前，本頁保留的資料/.test(m)), alerts);
      check(`${label}：未顯示匯入完成`, !t.some(x=>SUCCESS_RE.test(x)), t);
      check(`${label}：資料安全警告顯示`, await oldPage.locator("#cmDataSafetyWarning").isVisible());
      const shown = await visibleText(oldPage, entry);
      check(`${label}：畫面未呈現匯入候選資料`, !/A班（匯入檔）|匯入學生/.test(shown), shown.slice(0,300));
      // 實際下載救援檔
      const [dl] = await Promise.all([
        oldPage.waitForEvent("download"),
        oldPage.locator("#cmDataSafetyWarning button", {hasText:"下載本頁資料備份"}).click()
      ]);
      const dlPath = path.join(TMP, `rescue-${entry}.json`); await dl.saveAs(dlPath);
      const rescue = JSON.parse(fs.readFileSync(dlPath,"utf8"));
      const rescueA = rescue.data ? {name:rescue.className,data:rescue.data} : clsOf(rescue,"cA");
      const fn = dl.suggestedFilename();
      check(`${label}：救援檔為本頁資料（非匯入檔、非新分頁）`, rescueA && rescueA.name==="A班（原值）" && rescueA.data.students[0].name==="原A學生甲", {fn, name:rescueA&&rescueA.name, s:rescueA&&rescueA.data.students[0].name});
      check(`${label}：救援檔包含舊分頁的本頁修改`, rescueA && rescueA.data.students[1].name==="舊分頁修改學生乙", rescueA && rescueA.data.students.map(x=>x.name));
      check(`${label}：救援檔名可辨識為本頁資料`, /本頁/.test(fn) && (entry==="home" ? /全部班級/.test(fn) : /A班（原值）/.test(fn)), fn);
      await oldPage.reload();
      const st = await readStore(oldPage);
      check(`${label}：重新載入後為新分頁版本`, clsOf(st,"cA").name==="A班（新分頁修改）" && clsOf(st,"cA").data.students[0].name==="新分頁修改學生" && clsOf(st,"cA").data.students[1].name==="新分頁修改學生乙", clsOf(st,"cA").data.students.map(x=>x.name));
      check(`${label}：B 班維持原值`, JSON.stringify(clsOf(st,"cB"))===JSON.stringify(clsOf(newSaved,"cB")));
      await context.close();
    }

    // 驗收 3：取消／損壞／容量不足
    for(const entry of ["home","settings"]){
      for(const kind of ["cancel","corrupt","quota"]){
        const label = `[3] ${entry==="home"?"班級首頁":"班內設定"} ${({cancel:"取消確認",corrupt:"損壞 JSON",quota:"容量不足"})[kind]}`;
        const {context,page} = await newContext(browser,base);
        await page.evaluate(()=>{ enterClass("cA"); leaveClass(); enterClass("cB"); leaveClass(); });
        const before = await readStore(page);
        if(kind==="cancel") page.__policy.confirm = false;
        if(kind==="quota"){
          if(entry==="settings") await page.evaluate(()=>{ enterClass("cA"); setPage("settings"); });
          await page.evaluate(()=>{ window.__simulateQuota = true; });
        }
        await importVia(page, entry, kind==="corrupt" ? "corrupt" : "envelope");
        const t = await toasts(page);
        const alerts = page.__dialogs.filter(d=>d.type==="alert").map(d=>d.message);
        check(`${label}：未顯示匯入成功`, !t.some(x=>SUCCESS_RE.test(x)), t);
        if(kind==="corrupt") check(`${label}：提示格式錯誤`, alerts.some(m=>/JSON|無法匯入/.test(m)), alerts);
        if(kind==="cancel") check(`${label}：無錯誤提示`, alerts.length===0, alerts);
        if(kind==="quota") check(`${label}：提示寫入失敗`, alerts.some(m=>/儲存空間|無法寫入/.test(m)) && alerts.some(m=>/匯入未完成/.test(m)), alerts);
        const shown = await visibleText(page, entry);
        check(`${label}：畫面未呈現候選資料`, !/A班（匯入檔）|匯入學生/.test(shown), shown.slice(0,300));
        if(entry==="settings"){
          const mem = await page.evaluate(()=>({d:data.class.name, c:store.classes.find(c=>c.id==="cA").name}));
          check(`${label}：記憶體中仍為原資料`, mem.d==="A班（原值）" && mem.c==="A班（原值）", mem);
        }else{
          const mem = await page.evaluate(()=>store.classes.find(c=>c.id==="cA").name);
          check(`${label}：記憶體中仍為原資料`, mem==="A班（原值）", mem);
        }
        await page.evaluate(()=>{ window.__simulateQuota = false; });
        await page.reload();
        const st = await readStore(page);
        check(`${label}：重新載入後 A、B 班維持原值`, JSON.stringify(st)===JSON.stringify(before));
        await context.close();
      }
    }

    // 驗收 4：多班救援檔
    for(const entry of ["home","settings"]){
      const label = `[4] ${entry==="home"?"班級首頁":"班內設定"} 多班救援檔`;
      const {context,page} = await newContext(browser,base);
      await page.evaluate(()=>{ enterClass("cA"); leaveClass(); enterClass("cB"); leaveClass(); });
      const before = await readStore(page);
      await importVia(page, entry, "multi");
      const alerts = page.__dialogs.filter(d=>d.type==="alert").map(d=>d.message);
      const confirms = page.__dialogs.filter(d=>d.type==="confirm");
      check(`${label}：明確指出多班救援檔、僅支援單班`, alerts.some(m=>/多班救援檔/.test(m) && /僅支援單班/.test(m)), alerts);
      check(`${label}：在確認取代前即停止`, confirms.length===0, confirms);
      const t = await toasts(page);
      check(`${label}：未顯示匯入成功`, !t.some(x=>SUCCESS_RE.test(x)), t);
      check(`${label}：當下儲存未變`, JSON.stringify(await readStore(page))===JSON.stringify(before));
      await page.reload();
      check(`${label}：重新載入後 A、B 班維持原值`, JSON.stringify(await readStore(page))===JSON.stringify(before));
      await context.close();
    }

    // 回歸 5：舊鍵 V1 遷移仍可讀取；一般儲存的防覆寫機制仍有效
    { const context = await browser.newContext(); await context.addInitScript(INIT);
      const page = await openPage(context, base);
      await page.evaluate(v=>{ localStorage.clear(); localStorage.setItem("homeworkTrackerDataV1", v); }, JSON.stringify(classData("V1舊班","舊")));
      await page.reload();
      const st = await readStore(page);
      check("[5] 舊鍵 V1 資料遷移後可讀取", st && st.classes.length===1 && st.classes[0].name==="V1舊班" && st.classes[0].data.gradeItems.find(g=>g.id==="g1-舊").gradeTerm==="midterm", st && st.classes.map(c=>c.name));
      await context.close(); }
    { const {context,page:oldPage} = await newContext(browser,base);
      await oldPage.evaluate(()=>enterClass("cA"));
      const newPage = await openPage(context, base);
      await newPage.evaluate(async()=>{ enterClass("cA"); data.class.name="A班（新分頁修改）"; await saveData(); });
      await waitUntilVisible(oldPage, JSON.stringify(await readStore(newPage)));
      const saved = await oldPage.evaluate(()=>{ data.class.name="A班（舊分頁修改）"; return saveData(); });
      const st = await readStore(oldPage);
      check("[5] 舊分頁一般儲存仍被擋下，saveData() 回傳 false", saved===false && clsOf(st,"cA").name==="A班（新分頁修改）", {saved, name:clsOf(st,"cA").name});
      await context.close(); }

    // 審查 P1：讀檔期間切換班級，不得把備份寫到另一個班級
    for(const [entry,move] of [["home","switch"],["settings","switch"],["settings","leave"]]){
      const label = `[6] ${entry==="home"?"班級首頁":"班內設定"} 讀檔期間${move==="leave"?"離開班級":"切到 B 班"}`;
      const {context,page} = await newContext(browser,base);
      await page.evaluate(()=>{ enterClass("cA"); leaveClass(); enterClass("cB"); leaveClass(); });
      const before = await readStore(page);
      page.__dialogs.length = 0;
      await page.evaluate(()=>{ window.__toasts.length = 0; });
      if(entry==="home"){
        await page.evaluate(()=>openClassSettings("cA"));
        await page.evaluate(()=>{ window.__readGate = new Promise(r=>window.__releaseRead=r); });
        await page.setInputFiles('#modalBody input[type=file]', FILE_PATHS.envelope);
      }else{
        await page.evaluate(()=>{ enterClass("cA"); setPage("settings"); });
        await page.evaluate(()=>{ window.__readGate = new Promise(r=>window.__releaseRead=r); });
        await page.setInputFiles('#importInput', FILE_PATHS.envelope);
      }
      await page.waitForFunction(()=>window.__readStarted===true);
      if(move==="leave") await page.evaluate(()=>leaveClass());
      else await page.evaluate(()=>{ if(activeClassId) leaveClass(); enterClass("cB"); setPage("settings"); });
      await page.evaluate(()=>{ window.__releaseRead(); window.__readGate = null; });
      await settle(page);
      const alerts = page.__dialogs.filter(d=>d.type==="alert").map(d=>d.message);
      const confirms = page.__dialogs.filter(d=>d.type==="confirm");
      check(`${label}：取消匯入並說明班級已切換`, alerts.some(m=>/切換/.test(m) && /取消匯入/.test(m)), alerts);
      check(`${label}：未進到取代確認`, confirms.length===0, confirms.map(c=>c.message));
      check(`${label}：未顯示匯入成功`, !(await toasts(page)).some(x=>SUCCESS_RE.test(x)));
      if(move==="leave"){
        const home = await page.evaluate(()=>({active:activeClassId, cards:document.getElementById("classCardList").innerText, a:store.classes.find(c=>c.id==="cA").name}));
        check(`${label}：首頁仍為 A 班原資料`, home.active===null && /A班（原值）/.test(home.cards) && !/匯入/.test(home.cards) && home.a==="A班（原值）", home);
      }else{
        const mem = await page.evaluate(()=>({active:activeClassId, name:data.class.name}));
        check(`${label}：畫面仍為 B 班原資料`, mem.active==="cB" && mem.name==="B班（原值）", mem);
      }
      await page.reload();
      check(`${label}：重新載入後 A、B 班維持原值`, JSON.stringify(await readStore(page))===JSON.stringify(before));
      await context.close();
    }

    // 審查 P2：寫入成功後畫面更新拋錯，不得報成匯入失敗
    for(const entry of ["home","settings"]){
      const label = `[7] ${entry==="home"?"班級首頁":"班內設定"} 寫入成功後重繪失敗`;
      const {context,page} = await newContext(browser,base);
      await page.evaluate(()=>{ enterClass("cB"); leaveClass(); });
      const bBefore = clsOf(await readStore(page),"cB");
      if(entry==="settings") await page.evaluate(()=>{ enterClass("cA"); setPage("settings"); });
      else await page.evaluate(()=>openClassSettings("cA"));
      await page.evaluate(()=>{
        for(const fn of ["renderPage","renderClassHome","closeModal"]){
          const orig = window[fn];
          window[fn] = function(){ if(window.__failRender) throw new Error("模擬重繪失敗"); return orig.apply(this, arguments); };
        }
        window.__failRender = true;
      });
      page.__dialogs.length = 0;
      await page.evaluate(()=>{ window.__toasts.length = 0; });
      await page.setInputFiles(entry==="home" ? '#modalBody input[type=file]' : '#importInput', FILE_PATHS.envelope);
      await settle(page);
      const alerts = page.__dialogs.filter(d=>d.type==="alert").map(d=>d.message);
      check(`${label}：提示資料已儲存、請重新載入`, alerts.some(m=>m.includes("資料已儲存，請重新載入以更新畫面")), alerts);
      check(`${label}：未誤報為讀檔或匯入失敗`, !alerts.some(m=>/無法匯入|格式不正確|匯入未完成/.test(m)), alerts);
      await page.evaluate(()=>{ window.__failRender = false; });
      await page.reload();
      const st = await readStore(page);
      assertImportedA(st, label, "A班（匯入檔）");
      check(`${label}：B 班維持原值`, JSON.stringify(clsOf(st,"cB"))===JSON.stringify(bBefore));
      await context.close();
    }

    // 項目 3：首頁匯入攤平備份（來源班名與目標不同）保留目標班名，首頁與班內一致
    { const label = "[8] 班級首頁 × 攤平 班名一致";
      const {context,page} = await newContext(browser,base);
      await importVia(page, "home", "flat");
      let st = await readStore(page);
      check(`${label}：匯入後首頁與班內皆為目標班名`, clsOf(st,"cA").name==="A班（原值）" && clsOf(st,"cA").data.class.name==="A班（原值）", {name:clsOf(st,"cA").name, inner:clsOf(st,"cA").data.class.name});
      await page.reload();
      check(`${label}：重新載入後首頁卡片為目標班名`, await page.evaluate(()=>/A班（原值）/.test(document.getElementById("classCardList").innerText) && !/A班（匯入檔）/.test(document.getElementById("classCardList").innerText)));
      const inside = await page.evaluate(()=>{ enterClass("cA"); setPage("settings"); return {mem:data.class.name, header:document.getElementById("headerClassName").textContent}; });
      check(`${label}：進班後班內名稱與頁首皆為目標班名`, inside.mem==="A班（原值）" && inside.header==="A班（原值）", inside);
      const saved = await page.evaluate(()=>saveData());
      await page.reload();
      st = await readStore(page);
      check(`${label}：一般儲存並重新載入後兩處仍為目標班名`, saved===true && clsOf(st,"cA").name==="A班（原值）" && clsOf(st,"cA").data.class.name==="A班（原值）", {saved, name:clsOf(st,"cA").name, inner:clsOf(st,"cA").data.class.name});
      assertImportedA(st, label, "A班（原值）");
      await context.close(); }

    /* ---------------- 跨分頁寫入競爭 ---------------- */
    // 標記：舊分頁「舊分頁標記乙」、新分頁「A班（新分頁標記）／新分頁標記甲／新分頁標記乙」、候選備份「A班（匯入檔）／匯入學生」。
    const NEW_MARK = st => clsOf(st,"cA").name==="A班（新分頁標記）" && clsOf(st,"cA").data.students[0].name==="新分頁標記甲" && clsOf(st,"cA").data.students[1].name==="新分頁標記乙";
    const IMPORT_MARK = st => clsOf(st,"cA").name==="A班（匯入檔）" || clsOf(st,"cA").data.students[0].name==="匯入學生甲";
    const OLD_GENERAL_MARK = st => clsOf(st,"cA").data.students[0].name==="舊分頁一般儲存標記";
    async function setupOldTab(context, base, entry){
      const {page:oldPage} = {page: await openPage(context, base)};
      await oldPage.evaluate(([k,v])=>localStorage.setItem(k,v),[STORAGE_KEY,JSON.stringify(SEED)]);
      await oldPage.reload();
      await oldPage.evaluate(async()=>{ enterClass("cA"); data.students[1].name="舊分頁標記乙"; await saveData(); });
      if(entry==="home") await oldPage.evaluate(()=>leaveClass());
      else await oldPage.evaluate(()=>setPage("settings"));
      await flush(oldPage);
      return oldPage;
    }
    const newTabWrite = page => page.evaluate(async()=>{
      if(activeClassId!=="cA") enterClass("cA");
      data.class.name="A班（新分頁標記）"; data.students[0].name="新分頁標記甲"; data.students[1].name="新分頁標記乙";
      return await saveData();
    });
    async function startImport(page, entry){
      page.__dialogs.length = 0;
      await page.evaluate(()=>{ window.__toasts.length = 0; });
      if(entry==="home"){
        await page.evaluate(()=>openClassSettings("cA"));
        await page.setInputFiles('#modalBody input[type=file]', FILE_PATHS.envelope);
      }else{
        await page.setInputFiles('#importInput', FILE_PATHS.envelope);
      }
    }
    async function oldTabOutcome(page){
      await settle(page);
      const t = await toasts(page);
      return {success:t.some(x=>SUCCESS_RE.test(x)), alerts:page.__dialogs.filter(d=>d.type==="alert").map(d=>d.message)};
    }

    // [9] 不等待儲存同步：新分頁剛完成寫入，舊分頁立刻從實際入口匯入（真實瀏覽器競爭，重複 STRESS 次）
    for(const entry of ["home","settings"]){
      const label = `[9] ${entry==="home"?"班級首頁":"班內設定"} 新分頁剛寫入即從舊分頁匯入 ×${STRESS}`;
      let overwritten=0, falseSuccess=0, kept=0; const bad=[];
      for(let i=0;i<STRESS;i++){
        const context = await browser.newContext({acceptDownloads:true}); await context.addInitScript(INIT, {});
        const oldPage = await setupOldTab(context, base, entry);
        const newPage = await openPage(context, base);
        await newTabWrite(newPage);
        await startImport(oldPage, entry);            // 不等待舊分頁讀到新值
        const r = await oldTabOutcome(oldPage);
        await oldPage.reload();
        const st = await readStore(oldPage);
        if(IMPORT_MARK(st)) overwritten++;
        if(NEW_MARK(st)) kept++;
        if(r.success && !IMPORT_MARK(st)) falseSuccess++;
        if(!NEW_MARK(st) || r.success) bad.push({i, success:r.success, name:clsOf(st,"cA").name});
        await context.close();
      }
      check(`${label}：重新載入後皆為新分頁版本（候選備份未覆寫）`, kept===STRESS && overwritten===0, {kept, overwritten, bad:bad.slice(0,3)});
      check(`${label}：舊分頁皆未顯示匯入完成`, bad.every(b=>!b.success) && falseSuccess===0, {falseSuccess, bad:bad.slice(0,3)});
    }

    // [10] 決定性重現：舊分頁讀到尚未同步的舊值、且收不到 storage 事件，再匯入或一般儲存
    for(const action of ["home","settings","save"]){
      const label = `[10] 舊分頁讀到未同步舊值後${action==="save"?"一般儲存":`從${action==="home"?"班級首頁":"班內設定"}匯入`}`;
      const context = await browser.newContext({acceptDownloads:true}); await context.addInitScript(INIT, {});
      const oldPage = await setupOldTab(context, base, action==="save" ? "settings" : action);
      await oldPage.evaluate(k=>{ window.__staleView = {[k]: window.__realGetItem(k)}; }, STORAGE_KEY);
      const newPage = await openPage(context, base);
      check(`${label}：新分頁寫入成功`, await newTabWrite(newPage)===true);
      let r;
      if(action==="save"){
        const saved = await oldPage.evaluate(async()=>{ data.students[0].name="舊分頁一般儲存標記"; return await saveData(); });
        r = {success:saved===true, alerts:[]};
        check(`${label}：saveData() 回傳 false`, saved===false, saved);
      }else{
        await startImport(oldPage, action);
        r = await oldTabOutcome(oldPage);
        check(`${label}：提示衝突、未顯示匯入完成`, !r.success && r.alerts.some(m=>/其他分頁/.test(m) && /匯入未完成/.test(m)), r);
      }
      const warned = await oldPage.locator("#cmDataSafetyWarning").isVisible();
      check(`${label}：資料安全警告顯示`, warned);
      let rescueA = null;
      if(warned){
        const [dl] = await Promise.all([ oldPage.waitForEvent("download"),
          oldPage.locator("#cmDataSafetyWarning button", {hasText:"下載本頁資料備份"}).click() ]);
        const dlPath = path.join(TMP, `rescue-10-${action}.json`); await dl.saveAs(dlPath);
        const rescue = JSON.parse(fs.readFileSync(dlPath,"utf8"));
        rescueA = rescue.data ? {name:rescue.className,data:rescue.data} : clsOf(rescue,"cA");
      }
      check(`${label}：救援檔為本頁資料（含舊分頁標記，不含候選備份與新分頁標記）`,
        rescueA && rescueA.data.students[1].name==="舊分頁標記乙" && !/匯入/.test(JSON.stringify(rescueA)) && !/新分頁標記/.test(JSON.stringify(rescueA)),
        rescueA && {name:rescueA.name, students:rescueA.data.students.map(x=>x.name)});
      await oldPage.evaluate(()=>{ window.__staleView = null; });
      await oldPage.reload();
      const st = await readStore(oldPage);
      check(`${label}：重新載入後為新分頁版本`, NEW_MARK(st) && !IMPORT_MARK(st) && !OLD_GENERAL_MARK(st), clsOf(st,"cA").data.students.map(x=>x.name));
      await context.close();
    }

    // [11] 兩個分頁接近同時通過寫入前檢查：同一時間送出（stale＝兩分頁都看不到對方的寫入；real＝真實並行）
    for(const mode of ["stale","real"]){
      for(const action of ["home","settings","save"]){
        const runs = mode==="stale" ? 1 : STRESS;
        const label = `[11] 同時寫入（${mode==="stale"?"兩分頁皆讀到未同步舊值":`真實並行 ×${runs}`}）舊分頁${action==="save"?"一般儲存":`${action==="home"?"班級首頁":"班內設定"}匯入`} vs 新分頁一般儲存`;
        let bothOk=0, lost=0, noneOk=0; const bad=[];
        for(let i=0;i<runs;i++){
          const context = await browser.newContext({acceptDownloads:true}); await context.addInitScript(INIT, {});
          const oldPage = await setupOldTab(context, base, action==="save" ? "settings" : action);
          const newPage = await openPage(context, base);
          await newPage.evaluate(()=>enterClass("cA")); await flush(newPage);
          if(mode==="stale") for(const p of [oldPage,newPage]) await p.evaluate(k=>{ window.__staleView = {[k]: window.__realGetItem(k)}; }, STORAGE_KEY);
          if(action!=="save"){ // 先備妥檔案選擇器，讓兩邊的寫入幾乎同時發生
            oldPage.__dialogs.length = 0; await oldPage.evaluate(()=>{ window.__toasts.length = 0; });
            if(action==="home") await oldPage.evaluate(()=>openClassSettings("cA"));
          }
          const oldAct = action==="save"
            ? oldPage.evaluate(async()=>{ data.students[0].name="舊分頁一般儲存標記"; return await saveData(); })
            : oldPage.setInputFiles(action==="home" ? '#modalBody input[type=file]' : '#importInput', FILE_PATHS.envelope).then(()=>oldTabOutcome(oldPage)).then(r=>r.success);
          const [oldOk, newOk] = await Promise.all([oldAct, newTabWrite(newPage)]);
          for(const p of [oldPage,newPage]) await p.evaluate(()=>{ window.__staleView = null; });
          await oldPage.reload();
          const st = await readStore(oldPage);
          const oldWon = action==="save" ? OLD_GENERAL_MARK(st) : IMPORT_MARK(st);
          const newWon = NEW_MARK(st);
          if(oldOk && newOk) bothOk++;
          if(!oldOk && !newOk) noneOk++;
          // 回報成功的一方，其內容必須是重新載入後保留的內容
          if((oldOk && !oldWon) || (newOk && !newWon) || (oldWon===newWon)) lost++;
          if((oldOk && newOk) || lost) bad.push({i, oldOk, newOk, oldWon, newWon});
          await context.close();
        }
        check(`${label}：不會兩邊都回報成功`, bothOk===0, {bothOk, bad:bad.slice(0,3)});
        check(`${label}：回報成功的一方即為重新載入後保留的內容`, lost===0 && noneOk===0, {lost, noneOk, bad:bad.slice(0,3)});
      }
    }

    // [12] 瀏覽器無法提供協調（IndexedDB 不可用）：明確提示，匯入需再次確認
    for(const [kind,accept] of [["noIdb",false],["noIdb",true],["idbHang",true]]){
      const label = `[12] ${kind==="noIdb"?"IndexedDB 不可用":"IndexedDB 開啟無回應"} × ${accept?"確認繼續":"取消"}`;
      const {context,page} = await newContext(browser,base,{[kind]:true});
      if(kind==="idbHang") await page.waitForSelector("#cmSyncUnavailableNotice", {timeout:10000}).catch(()=>{});
      await page.evaluate(()=>{ enterClass("cA"); setPage("settings"); });
      const before = await readStore(page);
      check(`${label}：顯示無法協調的提醒`, await page.locator("#cmSyncUnavailableNotice").isVisible() && /無法提供跨分頁寫入協調/.test(await page.locator("#cmSyncUnavailableNotice").innerText()));
      page.__policy.confirm = msg => /無法提供跨分頁寫入協調/.test(msg) ? accept : true;
      await importVia(page, "settings", "envelope");
      const confirms = page.__dialogs.filter(d=>d.type==="confirm").map(d=>d.message);
      check(`${label}：匯入前另外確認（請先關閉其他分頁）`, confirms.some(m=>/無法提供跨分頁寫入協調/.test(m) && /關閉本網站的其他分頁/.test(m)), confirms);
      const t = await toasts(page);
      check(`${label}：${accept?"顯示匯入完成":"未顯示匯入完成"}`, accept ? t.some(x=>SUCCESS_RE.test(x)) : !t.some(x=>SUCCESS_RE.test(x)), t);
      await page.reload();
      const st = await readStore(page);
      if(accept) assertImportedA(st, label, "A班（匯入檔）");
      else check(`${label}：重新載入後資料未變`, JSON.stringify(st)===JSON.stringify(before));
      await context.close();
    }

    /* ---------------- 第三輪：三個邊界 ---------------- */
    const armCommitGate = page => page.evaluate(()=>{
      const orig = commitStoreOnce;
      window.__commitWaiting = 0;
      window.__gate = new Promise(r=>window.__releaseGate=r);
      commitStoreOnce = async (...args)=>{ window.__commitWaiting++; await window.__gate; return orig(...args); };
    });

    // [15] 等待儲存期間切班：A 班確認匯入 → 切到其他班或進入目標班 → A 寫入失敗
    for(const [entry,move] of [["settings","B"],["home","B"],["home","A"]]){
      const label = `[15] ${entry==="home"?"班級首頁":"班內設定"}匯入 A 班，等待寫入時${move==="B"?"切到 B 班":"進入 A 班"}，寫入失敗`;
      const {context,page} = await newContext(browser,base);
      await page.evaluate(()=>{ enterClass("cA"); leaveClass(); enterClass("cB"); leaveClass(); });
      if(entry==="settings") await page.evaluate(()=>{ enterClass("cA"); setPage("settings"); });
      const before = await readStore(page);
      await armCommitGate(page);
      page.__dialogs.length = 0; await page.evaluate(()=>{ window.__toasts.length = 0; });
      if(entry==="home"){ await page.evaluate(()=>openClassSettings("cA")); await page.setInputFiles('#modalBody input[type=file]', FILE_PATHS.envelope); }
      else await page.setInputFiles('#importInput', FILE_PATHS.envelope);
      await page.waitForFunction(()=>window.__commitWaiting>=1);
      await page.evaluate(target=>{ closeModal(); if(activeClassId) leaveClass(); enterClass(target==="B"?"cB":"cA"); setPage("settings"); }, move);
      await page.evaluate(()=>{ window.__simulateQuota = true; window.__releaseGate(); });
      await settle(page);
      await page.evaluate(()=>{ window.__simulateQuota = false; });
      const alerts = page.__dialogs.filter(d=>d.type==="alert").map(d=>d.message);
      check(`${label}：提示匯入未完成、未顯示成功`, alerts.some(m=>/匯入未完成/.test(m)) && !(await toasts(page)).some(x=>SUCCESS_RE.test(x)), alerts);
      const mem = await page.evaluate(()=>{
        const A=store.classes.find(c=>c.id==="cA"), B=store.classes.find(c=>c.id==="cB"), cur=store.classes.find(c=>c.id===activeClassId);
        return {active:activeClassId, dataIsActiveCls:data===cur.data, dataName:data.class.name, dataS0:data.students[0].name,
          header:document.getElementById("headerClassName").textContent, aName:A.name, aS0:A.data.students[0].name, aInner:A.data.class.name,
          bName:B.name, bS0:B.data.students[0].name};
      });
      const expectName = move==="B" ? "B班（原值）" : "A班（原值）", expectS0 = move==="B" ? "原B學生甲" : "原A學生甲";
      check(`${label}：目前分頁的 data 指向目前班級且為原資料`, mem.active===(move==="B"?"cB":"cA") && mem.dataIsActiveCls && mem.dataName===expectName && mem.dataS0===expectS0, mem);
      check(`${label}：頁首顯示目前班級`, mem.header===expectName, mem.header);
      check(`${label}：A 班回復為匯入前、B 班未被改動`, mem.aName==="A班（原值）" && mem.aInner==="A班（原值）" && mem.aS0==="原A學生甲" && mem.bName==="B班（原值）" && mem.bS0==="原B學生甲", mem);
      // 後續一般儲存：寫入失敗後依既有保護暫停寫入；編輯留在目前班級，不寫到其他班級
      const next = await page.evaluate(async()=>{ data.students[1].name="切班後一般儲存"; const ok=await saveData();
        const cur=store.classes.find(c=>c.id===activeClassId), other=store.classes.find(c=>c.id!==activeClassId);
        return {ok, curHasEdit:cur.data.students[1].name==="切班後一般儲存", dataIsCur:data===cur.data, otherUntouched:other.data.students[1].name!=="切班後一般儲存"}; });
      check(`${label}：後續一般儲存被暫停（回傳 false），編輯只留在目前班級`, next.ok===false && next.curHasEdit && next.dataIsCur && next.otherUntouched, next);
      const [dl] = await Promise.all([ page.waitForEvent("download"), page.locator("#cmDataSafetyWarning button", {hasText:"下載本頁資料備份"}).click() ]);
      const dlPath = path.join(TMP, `rescue-15-${entry}-${move}.json`); await dl.saveAs(dlPath);
      const rescue = JSON.parse(fs.readFileSync(dlPath,"utf8"));
      check(`${label}：救援檔為目前班級且含後續編輯、不含候選備份`, rescue.className===expectName && rescue.data.students[1].name==="切班後一般儲存" && !/匯入/.test(JSON.stringify(rescue)), {className:rescue.className, s:rescue.data.students.map(x=>x.name)});
      await page.reload();
      check(`${label}：重新載入後 A、B 班維持原值`, JSON.stringify(await readStore(page))===JSON.stringify(before));
      await context.close();
    }

    // [16] 明確匯入與本頁舊快照完全相同的備份：仍須在協調交易內驗證目前修訂號
    for(const entry of ["home","settings"]){
      const label = `[16] ${entry==="home"?"班級首頁":"班內設定"} 新分頁已存新版 → 舊分頁匯入與舊快照相同的備份`;
      const context = await browser.newContext({acceptDownloads:true}); await context.addInitScript(INIT, {});
      const oldPage = await setupOldTab(context, base, entry);
      const snap = await oldPage.evaluate(()=>{ const c=store.classes.find(x=>x.id==="cA"); return {app:"classroom-manager",version:APP_VERSION,className:c.name,data:normalizeData(c.data)}; });
      const snapPath = path.join(TMP, `snapshot-${entry}.json`); fs.writeFileSync(snapPath, JSON.stringify(snap));
      await oldPage.evaluate(k=>{ window.__staleView = {[k]: window.__realGetItem(k)}; }, STORAGE_KEY);
      const newPage = await openPage(context, base);
      check(`${label}：新分頁寫入成功`, await newTabWrite(newPage)===true);
      oldPage.__dialogs.length = 0; await oldPage.evaluate(()=>{ window.__toasts.length = 0; });
      if(entry==="home"){ await oldPage.evaluate(()=>openClassSettings("cA")); await oldPage.setInputFiles('#modalBody input[type=file]', snapPath); }
      else await oldPage.setInputFiles('#importInput', snapPath);
      const r = await oldTabOutcome(oldPage);
      check(`${label}：提示衝突、未顯示匯入完成`, !r.success && r.alerts.some(m=>/其他分頁/.test(m) && /匯入未完成/.test(m)), r);
      await oldPage.evaluate(()=>{ window.__staleView = null; });
      await oldPage.reload();
      check(`${label}：重新載入後為新分頁版本`, NEW_MARK(await readStore(oldPage)));
      await context.close();
    }
    { const label = "[16] 無其他分頁時匯入與目前內容相同的備份";
      const {context,page} = await newContext(browser,base);
      await page.evaluate(()=>{ enterClass("cA"); setPage("settings"); });
      const st0 = await readStore(page);
      const snap = await page.evaluate(()=>({className:store.classes.find(x=>x.id==="cA").name, data:normalizeData(store.classes.find(x=>x.id==="cA").data)}));
      const snapPath = path.join(TMP, "snapshot-alone.json"); fs.writeFileSync(snapPath, JSON.stringify(snap));
      page.__dialogs.length = 0; await page.evaluate(()=>{ window.__toasts.length = 0; });
      await page.setInputFiles('#importInput', snapPath); await settle(page);
      const st1 = await readStore(page);
      check(`${label}：顯示匯入完成，且經協調寫入（修訂號遞增）`, (await toasts(page)).some(x=>SUCCESS_RE.test(x)) && st1.syncRevision===st0.syncRevision+1, {rev0:st0.syncRevision, rev1:st1.syncRevision});
      const tab2 = await openPage(context, base);
      await tab2.evaluate(()=>enterClass("cA")); await flush(tab2);
      check(`${label}：另一分頁單純開班不增加修訂號`, (await readStore(tab2)).syncRevision===st1.syncRevision);
      await context.close(); }

    // [17] localStorage.setItem() 已成功、但 meta.put() 拋錯或交易中止（以及 setItem 之前就失敗）
    for(const [when,how] of [["afterSetItem","throw"],["afterSetItem","abort"],["beforeSetItem","throw"],["beforeSetItem","abort"]]){
      const label = `[17] meta.put ${how==="throw"?"拋錯":"交易中止"}（${when==="afterSetItem"?"setItem 成功之後":"setItem 之前"}）`;
      const context = await browser.newContext({acceptDownloads:true}); await context.addInitScript(INIT, {});
      // 其他分頁：先載入並持有目前版本，之後看不到寫入（凍結讀取、收不到 storage 事件）
      const other = await openPage(context, base);
      await other.evaluate(([k,v])=>localStorage.setItem(k,v),[STORAGE_KEY,JSON.stringify(SEED)]);
      await other.reload();
      await other.evaluate(()=>{ enterClass("cA"); }); await flush(other);
      const writer = await openPage(context, base);
      await writer.evaluate(()=>{ enterClass("cA"); setPage("settings"); }); await flush(writer);
      await other.evaluate(k=>{ window.__staleView = {[k]: window.__realGetItem(k)}; }, STORAGE_KEY);
      await writer.evaluate(f=>{ window.__metaPutFault = {...f, armedAt: window.__setItemCount}; window.__metaPutFaultHits = 0; }, {when,how});
      writer.__dialogs.length = 0; await writer.evaluate(()=>{ window.__toasts.length = 0; });
      await writer.setInputFiles('#importInput', FILE_PATHS.envelope);
      await settle(writer);
      const hits = await writer.evaluate(()=>{ const h=window.__metaPutFaultHits; window.__metaPutFault=null; return h; });
      check(`${label}：模擬確實觸發`, hits>=1, hits);
      // (1) 寫入結果：提示必須與實際儲存一致
      const t = await toasts(writer);
      const alerts = writer.__dialogs.filter(d=>d.type==="alert").map(d=>d.message);
      const stored = IMPORT_MARK(await readStore(writer));
      const saidSaved = t.some(x=>SUCCESS_RE.test(x)) || alerts.some(m=>/資料已儲存/.test(m));
      const saidNotSaved = alerts.some(m=>/匯入未完成/.test(m));
      check(`${label}：寫入結果與提示一致（${stored?"已儲存":"未儲存"}）`, stored ? (saidSaved && !saidNotSaved) : (saidNotSaved && !saidSaved), {stored, toasts:t, alerts});
      // (2) 重新載入後的內容（另開一個新分頁讀取，不重新載入寫入分頁）
      const reader = await openPage(context, base);
      const readerSt = await readStore(reader);
      check(`${label}：重新載入後的內容與提示一致`, IMPORT_MARK(readerSt)===stored, clsOf(readerSt,"cA").name);
      await reader.close();
      // (3a) 下一次寫入：其他分頁（持有較舊版本、看不到變更）不能靜默覆寫
      const otherSave = await other.evaluate(async()=>{ data.students[0].name="其他分頁覆寫標記"; return await saveData(); });
      const afterOther = await readStore(writer);
      const overwritten = clsOf(afterOther,"cA").data.students[0].name==="其他分頁覆寫標記";
      if(stored) check(`${label}：其他分頁的寫入被擋下、未覆寫已儲存的匯入`, otherSave===false && !overwritten && IMPORT_MARK(afterOther), {otherSave, name:clsOf(afterOther,"cA").name});
      else check(`${label}：未寫入任何內容，其他分頁的正常寫入不受影響`, otherSave===true && overwritten, {otherSave});
      // (3b) 下一次寫入：寫入分頁自己
      const writerNext = await writer.evaluate(async()=>{ data.memos.push({id:"memo-next",text:"寫入分頁下一次寫入"}); return await saveData(); });
      const afterWriter = await readStore(writer);
      const writerStored = JSON.stringify(clsOf(afterWriter,"cA").data.memos).includes("寫入分頁下一次寫入");
      if(when==="afterSetItem"){
        // 資料已儲存且修訂號已預約為本頁所有：本頁下一次寫入照常成功
        check(`${label}：寫入分頁下一次寫入成功並已儲存`, writerNext===true && writerStored && IMPORT_MARK(afterWriter), {writerNext, writerStored});
      }else{
        // 協調記錄寫不進去：本頁暫停寫入（依提示），下一次寫入回報 false 且未寫入
        check(`${label}：提示協調記錄寫入失敗`, alerts.some(m=>/跨分頁協調記錄/.test(m)), alerts);
        check(`${label}：寫入分頁下一次寫入被暫停（回傳 false，未寫入）`, writerNext===false && !writerStored, {writerNext, writerStored});
      }
      const finalReader = await openPage(context, base);
      const finalSt = await readStore(finalReader);
      check(`${label}：最後重新載入的內容與各次回報一致`,
        when==="afterSetItem" ? (IMPORT_MARK(finalSt) && JSON.stringify(clsOf(finalSt,"cA").data.memos).includes("寫入分頁下一次寫入"))
                              : (clsOf(finalSt,"cA").data.students[0].name==="其他分頁覆寫標記" && !IMPORT_MARK(finalSt)),
        {name:clsOf(finalSt,"cA").name, s0:clsOf(finalSt,"cA").data.students[0].name});
      await context.close();
    }

    // [18] 預約記錄留下但寫入分頁已不存在（關閉於預約與寫入之間）／仍存在
    for(const alive of [false,true]){
      const label = `[18] 未完成的預約，寫入分頁${alive?"仍開啟":"已關閉"}`;
      const {context,page} = await newContext(browser,base);
      await page.evaluate(()=>enterClass("cA")); await flush(page);
      const st0 = await readStore(page);
      const holder = await openPage(context, base);
      if(alive) await holder.evaluate(()=>{ window.__held = new Promise(res=>navigator.locks.request("homeworkTrackerTab:tab-fake", ()=>{ res(); return new Promise(()=>{}); })); return window.__held; });
      await holder.evaluate(rev=>new Promise((res,rej)=>{ const r=indexedDB.open("homeworkTrackerSync",1); r.onsuccess=()=>{ const tx=r.result.transaction("meta","readwrite");
        tx.objectStore("meta").put({rev:rev+1, baseRev:rev, state:"writing", writer:"tab-fake", at:new Date().toISOString()}, "homeworkTrackerDataV2"); tx.oncomplete=()=>{r.result.close();res();}; tx.onerror=()=>rej(tx.error); }; r.onerror=()=>rej(r.error); }), st0.syncRevision);
      const ok = await page.evaluate(async()=>{ data.students[0].name="預約後一般儲存"; return await saveData(); });
      const st1 = await readStore(page);
      const savedIt = clsOf(st1,"cA").data.students[0].name==="預約後一般儲存";
      if(alive) check(`${label}：視為其他分頁寫入中，儲存被擋下`, ok===false && !savedIt, {ok});
      else check(`${label}：回收預約，儲存成功`, ok===true && savedIt, {ok, rev:st1.syncRevision});
      await context.close();
    }

    // [13] 與舊版共存：v2.101 寫入後，舊版（無 syncRevision）再寫入；新版分頁重新載入後仍可正常儲存
    { const label = "[13] 舊版寫入（無修訂號）後新版仍可儲存";
      const {context,page} = await newContext(browser,base);
      const first = await page.evaluate(async()=>{ enterClass("cA"); data.students[0].name="新版寫入"; return await saveData(); });
      const st1 = await readStore(page);
      check(`${label}：新版寫入帶修訂號`, first===true && Number.isInteger(st1.syncRevision) && st1.syncRevision>0, st1.syncRevision);
      await page.evaluate(k=>{ const o=JSON.parse(window.__realGetItem(k)); delete o.syncRevision; o.classes[0].data.students[0].name="舊版寫入"; localStorage.setItem(k, JSON.stringify(o)); }, STORAGE_KEY);
      await page.reload();
      const saved = await page.evaluate(async()=>{ enterClass("cA"); const seen=data.students[0].name; data.students[1].name="舊版之後新版寫入"; return {seen, ok:await saveData()}; });
      await page.reload();
      const st2 = await readStore(page);
      check(`${label}：讀得到舊版資料並可儲存，未被誤擋`, saved.seen==="舊版寫入" && saved.ok===true && clsOf(st2,"cA").data.students[1].name==="舊版之後新版寫入" && st2.syncRevision>st1.syncRevision, {saved, rev:st2.syncRevision});
      await context.close(); }

    // [14] 不誤擋：兩分頁只是開啟同一班（沒有修改），第一個分頁之後的一般儲存仍應成功
    { const label = "[14] 兩分頁僅開啟同一班不造成衝突";
      const {context,page:tab1} = await newContext(browser,base);
      await tab1.evaluate(()=>enterClass("cA")); await flush(tab1);
      const tab2 = await openPage(context, base);
      await tab2.evaluate(()=>enterClass("cA")); await flush(tab2);
      const ok = await tab1.evaluate(async()=>{ data.students[0].name="分頁一修改"; return await saveData(); });
      const st = await readStore(tab1);
      check(`${label}：分頁一儲存成功且已寫入`, ok===true && clsOf(st,"cA").data.students[0].name==="分頁一修改" && !(await tab1.locator("#cmDataSafetyWarning").isVisible()), {ok, name:clsOf(st,"cA").data.students[0].name});
      await context.close(); }
  }finally{
    await browser.close();
    server.close();
  }
  const failed = results.filter(r=>!r.ok);
  console.log(`\n${results.length-failed.length}/${results.length} passed`);
  process.exit(failed.length?1:0);
}
run().catch(e=>{ console.error(e); process.exit(2); });
