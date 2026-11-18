#!/usr/bin/env node
/*
 * Classroom Manager — 成績 Excel（XLSX）結構回歸測試（僅供開發，網站不載入）。
 *
 * 執行（於網站根目錄）：
 *   node tests/xlsx-structure.test.js
 *   - SITE_DIR=<網站資料夾>：受測網站，預設為本檔上一層。
 *   - XLSX_VALIDATOR=<已建置的 xlsx-validate 執行檔>：Open XML SDK 驗證工具；未設定時，若系統有 dotnet 會自動建置
 *     tests/xlsx-validator（DocumentFormat.OpenXml 3.3.0）。找不到驗證工具時測試失敗；
 *     僅在明確設定 ALLOW_NO_VALIDATOR=1 時改為略過（並在結果中標示）。
 *   - KEEP_XLSX=<資料夾>：保留本次下載的 XLSX。
 *
 * 判定原則：ZIP 能解壓、XML 能解析、第三方套件能讀取，都不單獨視為 Excel 相容。
 * 每個檔案都必須同時通過 Open XML SDK 驗證，以及下列結構檢查（節點順序、關聯、樣式、儲存格型別、公式與快取值）。
 * 舊版（v2.102）以虛構資料產生的檔案 tests/fixtures/v2.102-full-class-wrong-order.xlsx 必須在節點順序檢查與驗證工具中都失敗。
 * 全部使用虛構資料；127.0.0.1 隨機埠獨立伺服器；每個情境使用全新的臨時瀏覽器設定檔。
 */
"use strict";
const http = require("http"), fs = require("fs"), os = require("os"), path = require("path"), zlib = require("zlib");
const { execFileSync, spawnSync } = require("child_process");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const SITE_DIR = path.resolve(process.env.SITE_DIR || ROOT);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hm-xlsx-"));
const OUT = process.env.KEEP_XLSX ? path.resolve(process.env.KEEP_XLSX) : path.join(TMP, "xlsx");
fs.mkdirSync(OUT, {recursive:true});
const OLD_FIXTURE = path.join(__dirname, "fixtures", "v2.102-full-class-wrong-order.xlsx");

/* ---------------- 結果 ---------------- */
const results = [];
function check(name, ok, detail){
  results.push({name, ok:!!ok});
  console.log(`${ok?"PASS":"FAIL"}  ${name}${!ok&&detail!==undefined?`\n      ${typeof detail==="string"?detail:JSON.stringify(detail).slice(0,1500)}`:""}`);
}

/* ---------------- Open XML SDK 驗證工具 ---------------- */
function findValidator(){
  if(process.env.XLSX_VALIDATOR) return path.resolve(process.env.XLSX_VALIDATOR);
  const proj = path.join(__dirname, "xlsx-validator"), exe = path.join(proj, "out", "xlsx-validate");
  if(fs.existsSync(exe)) return exe;
  const dotnet = spawnSync("dotnet", ["--version"], {encoding:"utf8"});
  if(dotnet.status !== 0) return null;
  const b = spawnSync("dotnet", ["build", "-c", "Release", "-o", path.join(proj,"out"), path.join(proj,"xlsx-validator.csproj")], {encoding:"utf8", env:{...process.env, DOTNET_CLI_TELEMETRY_OPTOUT:"1", DOTNET_NOLOGO:"1"}});
  if(b.status !== 0){ console.log(b.stdout.slice(-2000)); return null; }
  return exe;
}
function runValidator(exe, file){
  const r = spawnSync(exe, [file], {encoding:"utf8"});
  return {ok:r.status===0, output:(r.stdout||"")+(r.stderr||"")};
}

/* ---------------- ZIP 讀取（中央目錄、CRC32） ---------------- */
const CRC_TABLE = (()=>{ const t=new Uint32Array(256); for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1); t[n]=c>>>0; } return t; })();
const crc32 = buf=>{ let c=0xFFFFFFFF; for(const b of buf) c=CRC_TABLE[(c^b)&255]^(c>>>8); return (c^0xFFFFFFFF)>>>0; };
function readZip(file){
  const buf = fs.readFileSync(file), problems = [];
  const eocd = buf.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));
  if(eocd < 0) throw new Error("找不到 ZIP 結尾目錄");
  const count = buf.readUInt16LE(eocd+10), cdSize = buf.readUInt32LE(eocd+12), cdOff = buf.readUInt32LE(eocd+16);
  const entries = new Map(); let p = cdOff;
  for(let i=0;i<count;i++){
    if(buf.readUInt32LE(p)!==0x02014b50) throw new Error("中央目錄簽章錯誤");
    const method=buf.readUInt16LE(p+10), crc=buf.readUInt32LE(p+16), csize=buf.readUInt32LE(p+20), usize=buf.readUInt32LE(p+24);
    const nlen=buf.readUInt16LE(p+28), elen=buf.readUInt16LE(p+30), clen=buf.readUInt16LE(p+32), lho=buf.readUInt32LE(p+42);
    const name=buf.slice(p+46,p+46+nlen).toString("utf8");
    if(buf.readUInt32LE(lho)!==0x04034b50) problems.push(`${name}: 本機標頭簽章錯誤`);
    const lnl=buf.readUInt16LE(lho+26), lel=buf.readUInt16LE(lho+28), data=buf.slice(lho+30+lnl+lel, lho+30+lnl+lel+csize);
    const raw = method===0 ? data : method===8 ? zlib.inflateRawSync(data) : null;
    if(!raw) problems.push(`${name}: 不支援的壓縮方法 ${method}`);
    else{ if(raw.length!==usize) problems.push(`${name}: 解壓大小不符`); if(crc32(raw)!==crc) problems.push(`${name}: CRC 不符`); }
    if(entries.has(name)) problems.push(`${name}: 重複項目`);
    entries.set(name, raw ? raw.toString("utf8") : "");
    p += 46+nlen+elen+clen;
  }
  if(p !== cdOff+cdSize) problems.push("中央目錄大小不符");
  return {entries, problems, names:[...entries.keys()]};
}

/* ---------------- 結構檢查（在 Chromium 中以 DOMParser 解析 XML） ---------------- */
// SpreadsheetML 結構描述的子節點順序（ECMA-376 Part 1，CT_Worksheet / CT_Workbook）。
const WORKSHEET_SEQ = ["sheetPr","dimension","sheetViews","sheetFormatPr","cols","sheetData","sheetCalcPr","sheetProtection","protectedRanges","scenarios","autoFilter","sortState","dataConsolidate","customSheetViews","mergeCells","phoneticPr","conditionalFormatting","dataValidations","hyperlinks","printOptions","pageMargins","pageSetup","headerFooter","rowBreaks","colBreaks","customProperties","cellWatches","ignoredErrors","smartTags","drawing","legacyDrawing","legacyDrawingHF","drawingHF","picture","oleObjects","controls","webPublishItems","tableParts","extLst"];
const WORKBOOK_SEQ = ["fileVersion","fileSharing","workbookPr","workbookProtection","bookViews","sheets","functionGroups","externalReferences","definedNames","calcPr","oleSize","customWorkbookViews","pivotCaches","smartTagPr","smartTagTypes","webPublishing","fileRecoveryPr","webPublishObjects","extLst"];
function inspectInPage(parts, seq){
  const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const out = {parse:[], order:[], workbookOrder:[], rels:[], types:[], styles:[], cells:[], formulas:[], merges:[], filters:[], panes:[], sheets:[], info:{}};
  const parse = (name)=>{ const doc = new DOMParser().parseFromString(parts[name], "application/xml"); const err = doc.getElementsByTagName("parsererror")[0]; if(err) out.parse.push(`${name}: ${err.textContent.slice(0,120)}`); return doc; };
  const kids = el=>[...el.children];
  const orderOk = (el, list, label, bucket)=>{ let last=-1; for(const c of kids(el)){ const i=list.indexOf(c.localName); if(i<0){ bucket.push(`${label}: 未知子節點 ${c.localName}`); continue; } if(i<last) bucket.push(`${label}: ${c.localName} 不應在 ${list[last]} 之後`); last=Math.max(last,i); } };
  const colNum = s=>{ let n=0; for(const ch of s) n=n*26+(ch.charCodeAt(0)-64); return n; };
  const splitRef = r=>{ const m=/^\$?([A-Z]{1,3})\$?(\d+)$/.exec(r); return m?{c:colNum(m[1]),r:Number(m[2])}:null; };
  // [Content_Types].xml 與關聯
  const ct = parse("[Content_Types].xml");
  const defaults = Object.fromEntries([...ct.getElementsByTagName("Default")].map(d=>[d.getAttribute("Extension"), d.getAttribute("ContentType")]));
  const overrides = Object.fromEntries([...ct.getElementsByTagName("Override")].map(o=>[o.getAttribute("PartName").replace(/^\//,""), o.getAttribute("ContentType")]));
  for(const name of Object.keys(parts)){ if(name.endsWith("/")) continue; const ext=name.split(".").pop(); if(!overrides[name] && !defaults[ext]) out.types.push(`${name}: 沒有內容類型`); }
  for(const o of Object.keys(overrides)) if(!(o in parts)) out.types.push(`Override ${o}: 檔案不存在`);
  if(defaults.rels!=="application/vnd.openxmlformats-package.relationships+xml") out.types.push("rels 預設內容類型錯誤");
  if(overrides["xl/workbook.xml"]!=="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml") out.types.push("workbook 內容類型錯誤");
  const relsOf = (relsName, baseDir)=>{ const d=parse(relsName); const ids=new Set(); return [...d.getElementsByTagName("Relationship")].map(r=>{ const id=r.getAttribute("Id"); if(ids.has(id)) out.rels.push(`${relsName}: 重複 Id ${id}`); ids.add(id); const t=r.getAttribute("Target"); const full=(baseDir+t).replace(/^\//,""); if(!(full in parts)) out.rels.push(`${relsName}: ${id} → ${full} 不存在`); return {id, type:r.getAttribute("Type"), target:full}; }); };
  const root = relsOf("_rels/.rels", "");
  if(!root.some(r=>r.target==="xl/workbook.xml" && /officeDocument$/.test(r.type))) out.rels.push("_rels/.rels 沒有指向 workbook 的 officeDocument 關聯");
  const wbRels = relsOf("xl/_rels/workbook.xml.rels", "xl/");
  if(!wbRels.some(r=>/\/styles$/.test(r.type) && r.target==="xl/styles.xml")) out.rels.push("workbook 沒有 styles 關聯");
  // workbook
  const wb = parse("xl/workbook.xml"), wbRoot = wb.documentElement;
  orderOk(wbRoot, seq.workbook, "workbook.xml", out.workbookOrder);
  const sheetEls = [...wb.getElementsByTagNameNS(NS,"sheet")];
  const names = sheetEls.map(s=>s.getAttribute("name"));
  out.info.sheetNames = names;
  if(new Set(names.map(n=>n.toLowerCase())).size!==names.length) out.sheets.push("工作表名稱重複");
  for(const n of names) if(!n || n.length>31 || /[\[\]:*?\/\\]/.test(n) || /^'|'$/.test(n)) out.sheets.push(`工作表名稱不合法：${n}`);
  if(new Set(sheetEls.map(s=>s.getAttribute("sheetId"))).size!==sheetEls.length) out.sheets.push("sheetId 重複");
  const definedNames = [...wb.getElementsByTagNameNS(NS,"definedName")].map(d=>({name:d.getAttribute("name"), local:d.getAttribute("localSheetId"), hidden:d.getAttribute("hidden"), text:d.textContent}));
  // styles
  const st = parse("xl/styles.xml"), stRoot = st.documentElement;
  const countOf = tag=>{ const el=stRoot.getElementsByTagNameNS(NS,tag)[0]; if(!el) return 0; const n=kids(el).length; if(el.hasAttribute("count") && Number(el.getAttribute("count"))!==n) out.styles.push(`${tag} count=${el.getAttribute("count")} 與實際 ${n} 不符`); return n; };
  const nFonts=countOf("fonts"), nFills=countOf("fills"), nBorders=countOf("borders"), nCellStyleXfs=countOf("cellStyleXfs"), nXfs=countOf("cellXfs"); countOf("cellStyles");
  for(const xf of kids(stRoot.getElementsByTagNameNS(NS,"cellXfs")[0])){
    if(Number(xf.getAttribute("fontId"))>=nFonts || Number(xf.getAttribute("fillId"))>=nFills || Number(xf.getAttribute("borderId"))>=nBorders || Number(xf.getAttribute("xfId")||0)>=nCellStyleXfs) out.styles.push("cellXfs 參照超出範圍");
    const nf=Number(xf.getAttribute("numFmtId")); if(!(nf>=0 && nf<=49) && !st.querySelector(`numFmt[numFmtId="${nf}"]`)) out.styles.push(`未定義的 numFmtId ${nf}`);
  }
  // worksheets
  sheetEls.forEach((sEl, idx)=>{
    const rid = sEl.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships","id");
    const rel = wbRels.find(r=>r.id===rid);
    if(!rel || !/\/worksheet$/.test(rel.type)){ out.rels.push(`工作表 ${names[idx]} 的 r:id ${rid} 無效`); return; }
    const label = `${rel.target}（${names[idx]}）`;
    const ws = parse(rel.target), wsRoot = ws.documentElement;
    orderOk(wsRoot, seq.worksheet, label, out.order);
    const info = {name:names[idx], rows:0, formulas:0, maxFormula:0, cells:{}, headers:[]};
    let lastRow = 0, maxCol = 0;
    for(const row of wsRoot.getElementsByTagNameNS(NS,"row")){
      const r = Number(row.getAttribute("r")); if(!(r>lastRow)) out.cells.push(`${label}: 列號未遞增 ${r}`); lastRow = r; info.rows = r;
      let lastCol = 0;
      for(const c of kids(row)){
        if(c.localName!=="c"){ out.cells.push(`${label}: row 內有非 c 節點 ${c.localName}`); continue; }
        const ref = splitRef(c.getAttribute("r")); if(!ref || ref.r!==r){ out.cells.push(`${label}: 儲存格參照 ${c.getAttribute("r")} 與列 ${r} 不符`); continue; }
        if(!(ref.c>lastCol)) out.cells.push(`${label}: ${c.getAttribute("r")} 欄序未遞增或重複`); lastCol = ref.c; maxCol = Math.max(maxCol, ref.c);
        const s = Number(c.getAttribute("s")||0); if(!(s>=0 && s<nXfs)) out.styles.push(`${label}: ${c.getAttribute("r")} 樣式 ${s} 超出 cellXfs`);
        const t = c.getAttribute("t")||"n", f = c.getElementsByTagNameNS(NS,"f")[0], v = c.getElementsByTagNameNS(NS,"v")[0], is = c.getElementsByTagNameNS(NS,"is")[0];
        if(!["n","str","inlineStr","s","b","e"].includes(t)) out.cells.push(`${label}: ${c.getAttribute("r")} 型別 ${t} 不合法`);
        let value;
        if(f){
          const text = f.textContent; info.formulas++; info.maxFormula = Math.max(info.maxFormula, text.length);
          if(text.length>8192) out.formulas.push(`${label}: ${c.getAttribute("r")} 公式超過 8192 字元`);
          if(/^=/.test(text)) out.formulas.push(`${label}: ${c.getAttribute("r")} 公式不應以 = 開頭`);
          const refs = (text.match(/\b[A-Z]{1,3}\d+\b/g)||[]).map(splitRef);
          if(refs.some(x=>x.r!==r || x.c>=ref.c)) out.formulas.push(`${label}: ${c.getAttribute("r")} 公式參照到其他列或自身右側`);
          if(t==="str"){ if(v && v.textContent!=="") out.formulas.push(`${label}: ${c.getAttribute("r")} t="str" 但快取值非空`); value = {formula:text, cached:""}; }
          else if(t==="n"){ if(!v || !Number.isFinite(Number(v.textContent)) || v.textContent.trim()==="") out.formulas.push(`${label}: ${c.getAttribute("r")} 數值公式缺少有效快取值`); value = {formula:text, cached:Number(v?.textContent)}; }
          else out.formulas.push(`${label}: ${c.getAttribute("r")} 公式儲存格型別 ${t} 非預期`);
        }else if(t==="inlineStr"){
          if(!is || !is.getElementsByTagNameNS(NS,"t")[0]) out.cells.push(`${label}: ${c.getAttribute("r")} inlineStr 缺少 <is><t>`);
          value = [...is.getElementsByTagNameNS(NS,"t")].map(x=>x.textContent).join("");
          if(value.length>32767) out.cells.push(`${label}: ${c.getAttribute("r")} 文字超過 32767 字元`);
        }else if(t==="n"){
          if(!v || v.textContent.trim()==="" || !Number.isFinite(Number(v.textContent))) out.cells.push(`${label}: ${c.getAttribute("r")} 數值格式錯誤`);
          value = Number(v?.textContent);
        }else out.cells.push(`${label}: ${c.getAttribute("r")} 未預期的型別 ${t}`);
        info.cells[c.getAttribute("r")] = value;
      }
    }
    // 合併、篩選、凍結窗格
    const mc = wsRoot.getElementsByTagNameNS(NS,"mergeCells")[0];
    const mergeRefs = mc ? kids(mc).map(m=>m.getAttribute("ref")) : [];
    if(mc && Number(mc.getAttribute("count"))!==mergeRefs.length) out.merges.push(`${label}: mergeCells count 不符`);
    const af = wsRoot.getElementsByTagNameNS(NS,"autoFilter")[0];
    const cols = kids(wsRoot.getElementsByTagNameNS(NS,"cols")[0]||document.createElement("x")).length;
    const lastColLetter = (()=>{ let n=Math.max(2,cols), s=""; while(n>0){ n--; s=String.fromCharCode(65+n%26)+s; n=Math.floor(n/26);} return s; })();
    const dataRows = Math.max(0, info.rows-4);
    const expectFilter = `A4:${lastColLetter}${Math.max(4,dataRows+4)}`;
    if(!af) out.filters.push(`${label}: 缺少 autoFilter`);
    else if(af.getAttribute("ref")!==expectFilter) out.filters.push(`${label}: autoFilter ${af.getAttribute("ref")}，預期 ${expectFilter}`);
    const dn = definedNames.filter(d=>d.name==="_xlnm._FilterDatabase" && d.local===String(idx));
    const expectDn = `'${names[idx].replace(/'/g,"''")}'!$A$4:$${lastColLetter}$${Math.max(4,dataRows+4)}`;
    if(dn.length!==1 || dn[0].text!==expectDn || dn[0].hidden!=="1") out.filters.push(`${label}: _xlnm._FilterDatabase 應為 ${expectDn}（hidden），實際 ${JSON.stringify(dn)}`);
    if(JSON.stringify(mergeRefs)!==JSON.stringify([`A1:${lastColLetter}1`,`A2:${lastColLetter}2`])) out.merges.push(`${label}: 標題合併 ${JSON.stringify(mergeRefs)}`);
    const pane = wsRoot.getElementsByTagNameNS(NS,"pane")[0];
    if(!pane || pane.getAttribute("state")!=="frozen" || pane.getAttribute("ySplit")!=="4") out.panes.push(`${label}: 凍結窗格不符`);
    info.mergeRefs = mergeRefs; info.filter = af?.getAttribute("ref"); info.lastCol = lastColLetter; info.colCount = cols;
    out.info[names[idx]] = info;
  });
  out.info.definedNames = definedNames;
  return out;
}

/* ---------------- 虛構資料與匯出 ---------------- */
const STU = Array.from({length:6},(_,i)=>({id:`s${i+1}`,number:i+1,name:`虛構學生${i+1}`,tags:[]}));
const SPECIAL = `特殊<字元>&"引號"'單引號' 😀 Tab\t結尾`;
const ITEMS = [
  {id:"g1",subjectId:"sub-c",title:"國語小考（滿分 50）",date:"2026-09-01",createdAt:"2026-09-01T00:00:00Z",maxScore:50,gradeTerm:"midterm",scores:{s1:45,s2:0,s3:"38.5",s4:"",s5:null}},
  {id:"g2",subjectId:"sub-m",title:"數學期中考",date:"2026-09-02",createdAt:"2026-09-02T00:00:00Z",maxScore:100,gradeTerm:"midterm",scores:{s1:100,s2:59.99,s3:0,s4:88,s6:72.5}},
  {id:"g3",subjectId:"sub-m",title:"數學速算（滿分 7.5）",date:"2026-09-03",createdAt:"2026-09-03T00:00:00Z",maxScore:7.5,gradeTerm:"final",scores:{s1:7.5,s2:3,s5:6}},
  {id:"g4",subjectId:"sub-c",title:SPECIAL,date:"2026-09-04",createdAt:"2026-09-04T00:00:00Z",maxScore:"20",gradeTerm:"final",scores:{s1:"19",s2:20,s3:0}},
  {id:"g5",subjectId:"",title:"未分配區段的評量",date:"2026-09-05",createdAt:"2026-09-05T00:00:00Z",maxScore:100,gradeTerm:"",scores:{}}
];
const cls = (id,name,items,terms=true)=>({id,name,createdAt:"2026-01-01T00:00:00.000Z",data:{class:{name},students:STU,assignments:[],records:[],subjects:[{id:"sub-c",name:"國語"},{id:"sub-m",name:"數學&<科>"}],gradeItems:items,scores:{},settings:{gradeTermsEnabled:terms}}});
const SEED = {version:2,classes:[cls("cMain",`虛構匯出測試班 ${SPECIAL}`,ITEMS,true),cls("cNoTerm","虛構未啟用區段班",ITEMS.map(i=>({...i})),false),cls("cEmpty","虛構無評量班",[],true),cls("cNoStudent","虛構無學生班",ITEMS.slice(0,2).map(i=>({...i,scores:{}})),true)]};
SEED.classes[3].data.students = [];
const CASES = [
  {file:"01-完整班級-啟用期中期末",cls:"cMain",mode:"all",sheets:["全部成績","期中成績","期末成績","評量項目","逐筆分數"],items:["g1","g2","g3","g4","g5"]},
  {file:"02-目前範圍-國語-期末",cls:"cMain",mode:"current",subject:"sub-c",term:"final",sheets:["目前畫面","評量項目","逐筆分數"],items:["g4"]},
  {file:"03-目前範圍-全部科目-期中",cls:"cMain",mode:"current",subject:"all",term:"midterm",sheets:["目前畫面","評量項目","逐筆分數"],items:["g1","g2"]},
  {file:"04-目前範圍-數學-全部區段",cls:"cMain",mode:"current",subject:"sub-m",term:"all",sheets:["目前畫面","評量項目","逐筆分數"],items:["g2","g3"]},
  {file:"05-完整班級-未啟用區段",cls:"cNoTerm",mode:"all",sheets:["全部成績","評量項目","逐筆分數"],items:["g1","g2","g3","g4","g5"]},
  {file:"06-完整班級-無評量",cls:"cEmpty",mode:"all",sheets:["全部成績","期中成績","期末成績","評量項目","逐筆分數"],items:[]},
  {file:"07-目前範圍-無評量",cls:"cEmpty",mode:"current",subject:"all",term:"all",sheets:["目前畫面","評量項目","逐筆分數"],items:[]},
  {file:"08-完整班級-無學生",cls:"cNoStudent",mode:"all",sheets:["全部成績","期中成績","期末成績","評量項目","逐筆分數"],items:["g1","g2"],noStudents:true}
];
function expectedAverage(studentId, itemIds){
  const vals = itemIds.map(id=>ITEMS.find(i=>i.id===id)).map(i=>{ const v=i.scores[studentId]; if(v===null||v===undefined||v==="") return null; const n=Number(v), m=Number(i.maxScore); return Number.isFinite(n)&&m>0?n/m*100:null; }).filter(x=>x!==null);
  return vals.length ? Math.round(vals.reduce((a,b)=>a+b,0)/vals.length*10)/10 : null;
}

const TYPES = {".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"};
function startServer(root){
  const server = http.createServer((req,res)=>{ const rel=decodeURIComponent(new URL(req.url,"http://x").pathname).replace(/^\/+/,"")||"index.html";
    if(!["index.html","app.js","style.css"].includes(rel)){ res.writeHead(404); return res.end(); }
    res.writeHead(200,{"Content-Type":TYPES[path.extname(rel)]}); fs.createReadStream(path.join(root,rel)).pipe(res); });
  return new Promise(r=>server.listen(0,"127.0.0.1",()=>r(server)));
}

async function run(){
  const validator = findValidator();
  if(!validator){
    if(process.env.ALLOW_NO_VALIDATOR==="1") console.log("SKIP  未找到 Open XML SDK 驗證工具（ALLOW_NO_VALIDATOR=1）：本次結果不含結構描述驗證");
    else check("找到 Open XML SDK 驗證工具（設定 XLSX_VALIDATOR，或安裝 .NET SDK 以自動建置 tests/xlsx-validator）", false);
  }
  const server = await startServer(SITE_DIR);
  const base = `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await chromium.launch({env:{...process.env, LANG:process.env.LANG && /UTF-?8/i.test(process.env.LANG) ? process.env.LANG : "C.UTF-8"}});
  const parser = await (await browser.newContext()).newPage();
  const inspect = file=>{ const z = readZip(file); return parser.evaluate(([parts, seq, fn])=>{ const f = new Function("return "+fn)(); return f(parts, seq); }, [Object.fromEntries(z.entries), {worksheet:WORKSHEET_SEQ, workbook:WORKBOOK_SEQ}, inspectInPage.toString()]).then(r=>({...r, zip:z})); };
  try{
    /* [A] 舊版檔案必須被抓到 */
    { const r = await inspect(OLD_FIXTURE);
      check("[A] v2.102 舊檔：節點順序檢查判定失敗（autoFilter 在 mergeCells 之後）", r.order.length>0 && r.order.every(x=>/autoFilter 不應在 mergeCells 之後/.test(x)), r.order);
      if(validator){ const v = runValidator(validator, OLD_FIXTURE);
        check("[A] v2.102 舊檔：Open XML SDK 驗證判定無效（unexpected child element autoFilter）", !v.ok && /unexpected child element[^\n]*autoFilter/.test(v.output), v.output.slice(0,600)); }
      check("[A] v2.102 舊檔：ZIP 與 XML 本身可以解壓與解析（證明這兩項不足以判定相容）", r.zip.problems.length===0 && r.parse.length===0, {zip:r.zip.problems, parse:r.parse});
    }
    /* [B] 新版匯出：實際下載 */
    for(const c of CASES){
      const ctx = await browser.newContext({acceptDownloads:true}); const p = await ctx.newPage(); const errs = []; p.on("pageerror", e=>errs.push(e.message));
      await p.goto(base);
      await p.evaluate(s=>{ localStorage.clear(); localStorage.setItem("homeworkTrackerDataV2", s); }, JSON.stringify(SEED)); await p.reload();
      await p.evaluate(id=>{ enterClass(id); setPage("gradebook"); }, c.cls);
      await p.evaluate(async()=>{ try{ await __commitTail; }catch(e){} });
      if(c.mode==="current"){ await p.selectOption("#gradeSubjectFilter", c.subject); if(c.term!=="all") await p.locator(`[data-grade-term-view="${c.term}"]`).click(); }
      const before = await p.evaluate(()=>({ls:localStorage.getItem("homeworkTrackerDataV2"), mem:JSON.stringify(store)}));
      await p.locator("#exportGradeExcelBtn").click();
      const [dl] = await Promise.all([p.waitForEvent("download"), p.locator(c.mode==="all"?'button:has-text("下載完整 Excel")':'button:has-text("下載目前畫面 Excel")').click()]);
      const file = path.join(OUT, `${c.file}.xlsx`); await dl.saveAs(file);
      await p.evaluate(async()=>{ try{ await __commitTail; }catch(e){} });
      const after = await p.evaluate(()=>({ls:localStorage.getItem("homeworkTrackerDataV2"), mem:JSON.stringify(store), toast:document.getElementById("toast").textContent}));
      await ctx.close();
      const L = `[B] ${c.file}`;
      check(`${L}：下載完成（.xlsx），匯出唯讀（localStorage 與班級資料不變），無 JavaScript 錯誤`, /\.xlsx$/.test(dl.suggestedFilename()) && before.ls===after.ls && before.mem===after.mem && errs.length===0, {name:dl.suggestedFilename(), errs});
      if(validator){ const v = runValidator(validator, file); check(`${L}：Open XML SDK 驗證通過`, v.ok, v.output.slice(0,1200)); }
      const r = await inspect(file);
      check(`${L}：ZIP（CRC、大小、標頭）正確`, r.zip.problems.length===0, r.zip.problems);
      check(`${L}：所有 XML 可解析`, r.parse.length===0, r.parse);
      check(`${L}：工作表節點順序符合結構描述（sheetData → autoFilter → mergeCells → pageMargins）`, r.order.length===0, r.order);
      check(`${L}：workbook 節點順序符合結構描述（sheets → definedNames → calcPr）`, r.workbookOrder.length===0, r.workbookOrder);
      check(`${L}：內容類型與關聯完整`, r.types.length===0 && r.rels.length===0, {types:r.types, rels:r.rels});
      check(`${L}：樣式數量與索引正確`, r.styles.length===0, r.styles);
      check(`${L}：儲存格參照、型別、數值與文字正確`, r.cells.length===0 && r.sheets.length===0, {cells:r.cells, sheets:r.sheets});
      check(`${L}：公式（長度、參照、快取值型別）正確`, r.formulas.length===0, r.formulas);
      check(`${L}：篩選範圍與 _xlnm._FilterDatabase 一致、標題合併、凍結窗格保留`, r.filters.length===0 && r.merges.length===0 && r.panes.length===0, {filters:r.filters, merges:r.merges, panes:r.panes});
      check(`${L}：工作表為 ${c.sheets.join("、")}`, JSON.stringify(r.info.sheetNames)===JSON.stringify(c.sheets), r.info.sheetNames);
      // 內容：第一張工作表（總覽）
      const ov = r.info[c.sheets[0]], cells = ov.cells;
      const titles = c.items.map(id=>ITEMS.find(i=>i.id===id));
      const headerRow = Object.entries(cells).filter(([k])=>/^[A-Z]+4$/.test(k)).map(([,v])=>v);
      check(`${L}：總覽標題列為 座號、姓名、各評量、平均`, headerRow[0]==="座號" && headerRow[1]==="姓名" && headerRow[headerRow.length-1]==="平均（百分制）" && headerRow.length===titles.length+3, headerRow);
      check(`${L}：評量名稱（含特殊字元）原樣保留、包含原始滿分`, titles.every((it,j)=>String(headerRow[j+2]).includes(it.title) && String(headerRow[j+2]).endsWith(`（滿分 ${Number(it.maxScore)}）`)), headerRow.slice(2,-1));
      if(c.noStudents){ check(`${L}：無學生時只有標題與表頭，沒有公式`, ov.rows===4 && ov.formulas===0, {rows:ov.rows, formulas:ov.formulas}); }
      else{
        const avgCol = ov.lastCol; let bad = [];
        STU.forEach((s,k)=>{
          const row = k+5;
          titles.forEach((it,j)=>{ const col=String.fromCharCode(67+j), v=it.scores[s.id], got=cells[`${col}${row}`];
            const want = (v===null||v===undefined||v==="") ? undefined : Number(v);
            if(got!==want) bad.push({cell:`${col}${row}`, want, got}); });
          const avg = cells[`${avgCol}${row}`], want = expectedAverage(s.id, c.items);
          if(c.items.length===0){ if(avg!==undefined) bad.push({cell:`${avgCol}${row}`, want:"無公式", got:avg}); }
          else if(!avg || typeof avg!=="object" || !/ROUND\(/.test(avg.formula)) bad.push({cell:`${avgCol}${row}`, want:"平均公式", got:avg});
          else if(want===null ? avg.cached!=="" : avg.cached!==want) bad.push({cell:`${avgCol}${row}`, want, cached:avg.cached});
        });
        check(`${L}：原始分數照實寫入（未登記為空白、0 分為 0、數字字串為數值）`, bad.filter(b=>!/平均|無公式/.test(String(b.want))&&typeof b.want!=="object"&&b.cached===undefined).length===0, bad.slice(0,8));
        check(`${L}：平均欄${c.items.length?"為公式，快取值等於已登記分數換算百分制的平均（無登記時為空字串）":"在無評量時不輸出公式"}`, bad.length===0, bad.slice(0,8));
      }
      if(c.mode==="all" && c.sheets.includes("期中成績")){
        const mid = r.info["期中成績"], midHeaders = Object.entries(mid.cells).filter(([k])=>/^[A-Z]+4$/.test(k)).map(([,v])=>v);
        const midItems = c.items.filter(id=>ITEMS.find(i=>i.id===id).gradeTerm==="midterm");
        check(`${L}：期中工作表只含期中評量`, midHeaders.length===midItems.length+3, midHeaders);
      }
      check(`${L}：最長公式 ${ov.maxFormula} 字元（Excel 上限 8192）`, ov.maxFormula<=8192);
    }
    /* [C] 平均公式長度保護：任一公式超過 Excel 8,192 字元時停止下載並提示分批匯出。
           是否超限一律以「實際寫出的公式字數」判定：評量數、滿分位數與學生列號都會改變長度，不用固定評量數判斷。
           預測字數只用既有的 gradeExcelBuildSheets()/gradeExcelOverviewSheet() 產生公式後由測試自行量測，不依賴新加入的檢查函式。 */
    const LIMIT = 8192;
    const limitSeed = (n, max, studentCount, twoSubjects=false)=>{
      const students = Array.from({length:studentCount},(_,i)=>({id:`L-s${i+1}`,number:i+1,name:`虛構學生${i+1}`,tags:[]}));
      const items = Array.from({length:n},(_,i)=>({id:`L${i}`,subjectId:twoSubjects&&i%2?"sub-b":"sub-a",title:`虛構評量${i+1}`,date:"2026-09-01",
        createdAt:new Date(Date.UTC(2026,8,1,0,0,i)).toISOString(),maxScore:max,gradeTerm:i%2?"final":"midterm",scores:{"L-s1":max/2,"L-s2":0}}));
      return {version:2,classes:[{id:"cLimit",name:"虛構公式上限班",createdAt:"2026-01-01T00:00:00.000Z",data:{class:{name:"虛構公式上限班"},students,assignments:[],records:[],
        subjects:[{id:"sub-a",name:"虛構科目甲"},{id:"sub-b",name:"虛構科目乙"}],gradeItems:items,scores:{},settings:{gradeTermsEnabled:true}}}]};
    };
    const measurePage = await (await browser.newContext()).newPage(); await measurePage.goto(base);
    // 完整匯出時所有工作表中最長公式的字數（使用既有函式產生公式，再由測試量測）
    const longestFull = seed=>measurePage.evaluate(s=>{ data = s.classes[0].data; let m = 0;
      for(const sh of gradeExcelBuildSheets("all")) for(const row of sh.rows) for(const v of row) if(v && typeof v==="object" && typeof v.formula==="string") m = Math.max(m, v.formula.length);
      return m; }, seed);
    // 只量總覽表（快速，用於搜尋邊界）
    const longestOverview = (n,max,studentCount)=>measurePage.evaluate(([n,max,k])=>{ const items=Array.from({length:n},(_,i)=>({id:"q"+i,subjectId:"",title:"t",date:"2026-01-01",maxScore:max,scores:{}}));
      const st=Array.from({length:k},(_,i)=>({id:"p"+i,number:i+1,name:"x",tags:[]})); data={...defaultData(),students:st,gradeItems:items};
      const sh=gradeExcelOverviewSheet("全部成績",items,st,"x"); return Math.max(...sh.rows.map(r=>r[r.length-1].formula.length)); }, [n,max,studentCount]);
    async function exportUI(seed, mode, opts={}){
      const ctx = await browser.newContext({acceptDownloads:true}); const p = await ctx.newPage(); const alerts = [], errs = [];
      p.on("dialog", d=>{ alerts.push(d.message()); d.accept(); }); p.on("pageerror", e=>errs.push(e.message));
      await p.goto(base); await p.evaluate(s=>{ localStorage.clear(); localStorage.setItem("homeworkTrackerDataV2", s); }, JSON.stringify(seed)); await p.reload();
      await p.evaluate(()=>{ enterClass("cLimit"); setPage("gradebook"); }); await p.evaluate(async()=>{ try{ await __commitTail; }catch(e){} });
      if(opts.subject) await p.selectOption("#gradeSubjectFilter", opts.subject);
      if(opts.term) await p.locator(`[data-grade-term-view="${opts.term}"]`).click();
      const before = await p.evaluate(()=>({ls:localStorage.getItem("homeworkTrackerDataV2"), mem:JSON.stringify(store)}));
      await p.locator("#exportGradeExcelBtn").click();
      const dlPromise = p.waitForEvent("download", {timeout:6000}).catch(()=>null);
      await p.locator(mode==="all"?'button:has-text("下載完整 Excel")':'button:has-text("下載目前畫面 Excel")').click();
      const dl = await dlPromise; let file = null;
      if(dl){ file = path.join(OUT, `${opts.save||"limit-"+Date.now()}.xlsx`); await dl.saveAs(file); }
      await p.evaluate(async()=>{ try{ await __commitTail; }catch(e){} });
      const after = await p.evaluate(()=>({ls:localStorage.getItem("homeworkTrackerDataV2"), mem:JSON.stringify(store), modalOpen:!document.getElementById("modalBackdrop").classList.contains("hidden"), toast:document.getElementById("toast").textContent}));
      await ctx.close();
      return {downloaded:!!dl, file, alerts, errs, unchanged:before.ls===after.ls && before.mem===after.mem, modalOpen:after.modalOpen, toast:after.toast};
    }
    const fileLongest = async file=>{ const r = await inspect(file); return {r, longest:Math.max(...r.info.sheetNames.map(n=>r.info[n].maxFormula))}; };
    const blockedOk = (x, length)=>!x.downloaded && x.alerts.length===1 && x.alerts[0].includes(`${length.toLocaleString("en-US")} 字元`) && x.alerts[0].includes("8,192")
      && /科目/.test(x.alerts[0]) && /期中／期末/.test(x.alerts[0]) && /分批匯出/.test(x.alerts[0]) && /沒有下載任何檔案/.test(x.alerts[0]) && x.unchanged && x.errs.length===0 && !/已產生/.test(x.toast);
    const validOk = file=>validator ? runValidator(validator, file).ok : true;
    // C1／C2：滿分 100、6 位學生；找出不超限的最大評量數與下一個
    { let n = 80; while((await longestOverview(n+1,100,6))<=LIMIT) n++;
      const okSeed = limitSeed(n,100,6), badSeed = limitSeed(n+1,100,6);
      const okLen = await longestFull(okSeed), badLen = await longestFull(badSeed);
      console.log(`INFO  [C] 滿分 100、6 位學生：${n} 項評量 → 最長公式 ${okLen} 字元；${n+1} 項 → ${badLen} 字元`);
      const ok = await exportUI(okSeed, "all", {save:`09-公式接近上限-${okLen}字元-${n}項`});
      const f = ok.file ? await fileLongest(ok.file) : null;
      check(`[C] 限制內（${n} 項、最長 ${okLen} 字元）：正常下載，Open XML SDK 驗證通過，結構檢查無誤`, ok.downloaded && ok.alerts.length===0 && ok.unchanged && validOk(ok.file) && f && f.r.order.length===0 && f.r.formulas.length===0, {ok, issues:f&&[f.r.order,f.r.formulas]});
      check(`[C] 限制內：檔案中實際最長公式 ${f?.longest} 字元，等於預測且不超過 8,192`, f && f.longest===okLen && okLen<=LIMIT && okLen>LIMIT-200, {file:f?.longest, okLen});
      const bad = await exportUI(badSeed, "all");
      check(`[C] 超限（${n+1} 項、${badLen} 字元）：不下載，提示實際字數、上限與分批方式，班級資料不變`, badLen>LIMIT && blockedOk(bad, badLen), bad);
      check("[C] 超限時匯出視窗保留，可直接改選「目前畫面」", bad.modalOpen);
      // ChatGPT 重現案例：110 項滿分 100（5 位學生，第 5～9 列，公式 8,287 字元）
      const r110 = limitSeed(110,100,5), len110 = await longestFull(r110);
      const x110 = await exportUI(r110, "all");
      check(`[C] 重現案例：110 項滿分 100 的平均公式為 8,287 字元，不下載並提示`, len110===8287 && blockedOk(x110, 8287), {len110, alerts:x110.alerts});
      // C5：分批：同樣超限的資料分成兩個科目，改用「目前畫面」單一科目可正常下載
      const split = limitSeed(n+1,100,6,true), splitLen = await longestFull(split);
      const full = await exportUI(split, "all");
      const part = await exportUI(split, "current", {subject:"sub-a", save:"10-分批匯出-單一科目"});
      const pf = part.file ? await fileLongest(part.file) : null;
      check(`[C] 分批：完整匯出（${splitLen} 字元）被擋下，改用科目篩選的目前畫面可正常下載且有效`, splitLen>LIMIT && blockedOk(full, splitLen) && part.downloaded && part.alerts.length===0 && validOk(part.file) && pf && pf.longest<=LIMIT, {full:full.alerts, part:{downloaded:part.downloaded, alerts:part.alerts, longest:pf?.longest}});
      const termPart = await exportUI(split, "current", {term:"midterm", save:"11-分批匯出-期中區段"});
      check("[C] 分批：改用「期中」區段的目前畫面也可正常下載且有效", termPart.downloaded && termPart.alerts.length===0 && validOk(termPart.file), termPart.alerts);
      const curBad = await exportUI(badSeed, "current");
      check("[C] 目前畫面仍超限時同樣不下載，並提示再縮小範圍", blockedOk(curBad, badLen) && /再縮小範圍/.test(curBad.alerts[0]||""), curBad.alerts);
    }
    // C3：同樣評量數，滿分位數不同（1 與 12.5）造成一個可匯出、一個超限
    { let n = 80; while(!((await longestOverview(n,1,6))<=LIMIT && (await longestOverview(n,12.5,6))>LIMIT) && n<200) n++;
      const a = limitSeed(n,1,6), b = limitSeed(n,12.5,6), la = await longestFull(a), lb = await longestFull(b);
      console.log(`INFO  [C] ${n} 項評量、6 位學生：滿分 1 → ${la} 字元；滿分 12.5 → ${lb} 字元`);
      const xa = await exportUI(a, "all", {save:`12-滿分1-${n}項-${la}字元`}), xb = await exportUI(b, "all");
      check(`[C] 滿分位數差異：${n} 項、滿分 1（${la} 字元）可下載且有效；滿分 12.5（${lb} 字元）不下載並提示`, la<=LIMIT && lb>LIMIT && xa.downloaded && xa.alerts.length===0 && validOk(xa.file) && blockedOk(xb, lb), {la, lb, xa:xa.alerts, xb:xb.alerts});
    }
    // C4：同樣評量數，學生列號位數不同（5 位學生 vs 996 位學生，最後一列為第 1000 列）
    { let n = 80; while(!((await longestOverview(n,100,5))<=LIMIT && (await longestOverview(n,100,996))>LIMIT) && n<200) n++;
      const a = limitSeed(n,100,5), b = limitSeed(n,100,996), la = await longestFull(a), lb = await longestFull(b);
      console.log(`INFO  [C] ${n} 項評量、滿分 100：5 位學生 → ${la} 字元；996 位學生 → ${lb} 字元`);
      const xa = await exportUI(a, "all", {save:`13-學生5位-${n}項-${la}字元`}), xb = await exportUI(b, "all");
      const cellRow = Number(((xb.alerts[0]||"").match(/工作表 [A-Z]+(\d+)（/)||[])[1]);
      check(`[C] 學生列號差異：${n} 項、5 位學生（${la} 字元）可下載且有效；996 位學生（${lb} 字元）不下載並提示`, la<=LIMIT && lb>LIMIT && xa.downloaded && xa.alerts.length===0 && validOk(xa.file) && blockedOk(xb, lb), {la, lb, xa:xa.alerts, xb:xb.alerts});
      check(`[C] 學生列號差異：提示指出最長公式所在的後段列（第 ${cellRow} 列，列號 4 位數）`, cellRow>=1000, xb.alerts[0]);
    }
    await measurePage.context().close();
  }finally{ await browser.close(); server.close(); }
  const failed = results.filter(r=>!r.ok);
  console.log(`\nXLSX：${OUT}`);
  console.log(`${results.length-failed.length}/${results.length} passed`);
  process.exit(failed.length?1:0);
}
run().catch(e=>{ console.error(e); process.exit(2); });
