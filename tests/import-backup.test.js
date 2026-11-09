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
const INIT = () => {
  // 模擬容量不足：僅在測試設定旗標時讓寫入失敗。
  const orig = Storage.prototype.setItem;
  Storage.prototype.setItem = function(k,v){
    if(window.__simulateQuota) throw new DOMException("模擬容量不足","QuotaExceededError");
    return orig.call(this,k,v);
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
    page.__dialogs.push({type:d.type(),message:d.message()});
    if(d.type()==="confirm") return page.__policy.confirm ? d.accept() : d.dismiss();
    return d.accept();
  });
  await page.goto(base);
  return page;
}
async function newContext(browser, base){
  const context = await browser.newContext({acceptDownloads:true});
  await context.addInitScript(INIT);
  const page = await openPage(context, base);
  await page.evaluate(([k,v])=>localStorage.setItem(k,v),[STORAGE_KEY,JSON.stringify(SEED)]);
  await page.reload();
  return {context,page};
}
const readStore = page => page.evaluate(k=>JSON.parse(localStorage.getItem(k)),STORAGE_KEY);
const clsOf = (st,id) => st.classes.find(c=>c.id===id);
const toasts = page => page.evaluate(()=>window.__toasts.slice());

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
  await page.waitForTimeout(500);
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
        await page.reload();
        const st = await readStore(page);
        // 首頁入口沿用 className；班內設定沿用備份內 class.name（既有行為）；攤平格式於首頁入口不改班名（既有行為）
        const expectedName = (entry==="home" && fmt==="flat") ? "A班（原值）" : "A班（匯入檔）";
        assertImportedA(st, label, expectedName);
        check(`${label}：B 班維持原值`, JSON.stringify(clsOf(st,"cB"))===JSON.stringify(bBefore));
        await context.close();
      }
    }

    // 驗收 2：舊分頁不能覆寫較新資料
    for(const entry of ["home","settings"]){
      const label = `[2] ${entry==="home"?"班級首頁":"班內設定"} 舊分頁匯入`;
      const {context,page:oldPage} = await newContext(browser,base);
      if(entry==="settings") await oldPage.evaluate(()=>{ enterClass("cA"); setPage("settings"); });
      const newPage = await openPage(context, base);
      await newPage.evaluate(()=>{ enterClass("cA"); data.class.name="A班（新分頁修改）"; data.students[0].name="新分頁修改學生"; saveData(); });
      const newSaved = await readStore(newPage);
      check(`${label}：新分頁已寫入`, clsOf(newSaved,"cA").name==="A班（新分頁修改）");
      await importVia(oldPage, entry, "envelope");
      const t = await toasts(oldPage);
      const alerts = oldPage.__dialogs.filter(d=>d.type==="alert").map(d=>d.message);
      check(`${label}：提示衝突`, alerts.some(m=>/其他分頁/.test(m)) && alerts.some(m=>/匯入未完成|沒有寫入|未寫入/.test(m)), alerts);
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
      check(`${label}：救援檔名可辨識為本頁資料`, /本頁/.test(fn) && (entry==="home" ? /全部班級/.test(fn) : /A班（原值）/.test(fn)), fn);
      await oldPage.reload();
      const st = await readStore(oldPage);
      check(`${label}：重新載入後為新分頁版本`, clsOf(st,"cA").name==="A班（新分頁修改）" && clsOf(st,"cA").data.students[0].name==="新分頁修改學生", clsOf(st,"cA").name);
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
      await newPage.evaluate(()=>{ enterClass("cA"); data.class.name="A班（新分頁修改）"; saveData(); });
      const saved = await oldPage.evaluate(()=>{ data.class.name="A班（舊分頁修改）"; return saveData(); });
      const st = await readStore(oldPage);
      check("[5] 舊分頁一般儲存仍被擋下，saveData() 回傳 false", saved===false && clsOf(st,"cA").name==="A班（新分頁修改）", {saved, name:clsOf(st,"cA").name});
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
