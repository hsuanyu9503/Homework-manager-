const APP_VERSION = "2.21";

const STORAGE_KEY = "homeworkTrackerDataV2";
const LEGACY_STORAGE_KEY = "homeworkTrackerDataV1";

const STATUS_ORDER = ["pending","submitted","correction","completed","missing"];
const STATUS_LABEL = {
  pending:"未確認",
  submitted:"已交",
  correction:"待訂正",
  completed:"完成",
  missing:"缺交"
};

let store = loadStore();
let activeClassId = null;
let data = defaultData();
let currentPage = "dashboard";
let showAllAssignmentsMode = false;
let showAllContactItemsMode = false;

function defaultData(){
  return {
    version:1,
    class:{name:""},
    students:[],
    assignments:[],
    records:[],
    contactItems:[],
    notices:[],
    memos:[],
    scores:{},
    groups:[],
    groupScores:{},
    assignmentGroups:[],
    settings:{overdueDays:2}
  };
}

function loadStore(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw){
      const parsed = JSON.parse(raw);
      if(parsed && Array.isArray(parsed.classes)){
        return {
          version:2,
          classes:parsed.classes.map(c=>({
            id:c.id || uid("c"),
            name:c.name || "未命名班級",
            createdAt:c.createdAt || new Date().toISOString(),
            data:normalizeData(c.data || {})
          }))
        };
      }
    }

    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if(legacyRaw){
      const legacy = normalizeData(JSON.parse(legacyRaw));
      const migrated = {
        version:2,
        classes:[{
          id:uid("c"),
          name:legacy.class.name || "我的班級",
          createdAt:new Date().toISOString(),
          data:legacy
        }]
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      return migrated;
    }
  }catch(e){
    console.error(e);
  }
  return {version:2, classes:[]};
}

function normalizeData(input){
  return {
    version:1,
    class:{name: input?.class?.name || ""},
    students:Array.isArray(input?.students) ? input.students.map(s=>({...s,tags:Array.isArray(s.tags)?s.tags:[]})) : [],
    assignments:Array.isArray(input?.assignments) ? input.assignments : [],
    records:Array.isArray(input?.records) ? input.records : [],
    contactItems:(Array.isArray(input?.contactItems)
      ? input.contactItems
      : (Array.isArray(input?.contactBook) ? input.contactBook : [])).map((item,index)=>({
        ...item,
        order:Number.isFinite(Number(item?.order)) ? Number(item.order) : index
      })),
    notices:Array.isArray(input?.notices) ? input.notices : [],
    memos:Array.isArray(input?.memos) ? input.memos : [],
    scores:(input?.scores && typeof input.scores==="object") ? input.scores : {},
    groups:Array.isArray(input?.groups) ? input.groups : [],
    groupScores:(input?.groupScores && typeof input.groupScores==="object") ? input.groupScores : {},
    assignmentGroups:Array.isArray(input?.assignmentGroups) ? input.assignmentGroups : [],
    seating:{
      rows:Math.max(1,Math.min(10,Number(input?.seating?.rows)||5)),
      cols:Math.max(1,Math.min(10,Number(input?.seating?.cols)||3)),
      slots:Array.isArray(input?.seating?.slots) ? input.seating.slots : [],
      view:input?.seating?.view==="student" ? "student" : "teacher",
      rules:Array.isArray(input?.seating?.rules)?input.seating.rules:[],
      history:Array.isArray(input?.seating?.history)?input.seating.history.slice(0,20):[]
    },
    settings:{
      overdueDays:Number.isFinite(Number(input?.settings?.overdueDays)) ? Math.max(0, Number(input.settings.overdueDays)) : 2
    }
  };
}

function saveData(){
  if(activeClassId){
    const cls = store.classes.find(c=>c.id===activeClassId);
    if(cls){
      cls.name = data.class.name || cls.name || "未命名班級";
      cls.data = data;
    }
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  if(activeClassId) renderPage(currentPage);
  else renderClassHome();
}

function uid(prefix="id"){
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
}

function localDateString(d=new Date()){
  const pad = n => String(n).padStart(2,"0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function formatDate(dateStr){
  if(!dateStr) return "";
  const [y,m,d] = dateStr.split("-");
  return `${y}/${m}/${d}`;
}

function formatToday(){
  const d = new Date();
  const names = ["日","一","二","三","四","五","六"];
  return `${d.getFullYear()} / ${String(d.getMonth()+1).padStart(2,"0")} / ${String(d.getDate()).padStart(2,"0")}　星期${names[d.getDay()]}`;
}


function daysSinceDate(dateStr){
  if(!dateStr) return 0;
  const parts = dateStr.split("-").map(Number);
  if(parts.length!==3 || parts.some(n=>!Number.isFinite(n))) return 0;
  const target = new Date(parts[0], parts[1]-1, parts[2]);
  const today = new Date();
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startTarget = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  return Math.floor((startToday - startTarget) / 86400000);
}

function overdueThresholdDays(){
  const value = Number(data?.settings?.overdueDays);
  return Number.isFinite(value) ? Math.max(0, value) : 2;
}

function getRecord(assignmentId, studentId){
  return data.records.find(r => r.assignmentId === assignmentId && r.studentId === studentId);
}

function ensureRecord(assignmentId, studentId){
  let r = getRecord(assignmentId, studentId);
  if(!r){
    r = {assignmentId, studentId, status:"pending", note:""};
    data.records.push(r);
  }
  return r;
}

function assignmentCounts(assignmentId){
  const counts = {pending:0,submitted:0,correction:0,completed:0,missing:0};
  data.students.forEach(s=>{
    const r = getRecord(assignmentId, s.id);
    counts[r?.status || "pending"]++;
  });
  return counts;
}

function assignmentProgress(assignmentId){
  const counts = assignmentCounts(assignmentId);
  const total = data.students.length;
  const percent = total ? Math.round((counts.completed / total) * 100) : 0;
  return {counts, total, percent};
}


function persistActiveClass(){
  if(!activeClassId) return;
  const cls = store.classes.find(c=>c.id===activeClassId);
  if(!cls) return;
  cls.name = data.class.name || cls.name || "未命名班級";
  cls.data = data;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function renderClassHome(){
  const list = document.getElementById("classCardList");
  if(!list) return;
  if(!store.classes.length){
    list.innerHTML = `<div class="class-empty">目前還沒有班級。<br>點選「新增班級」開始建立。</div>`;
    return;
  }

  list.innerHTML = store.classes.map(cls=>{
    const d = normalizeData(cls.data);
    const missing = d.records.filter(r=>r.status==="missing").length;
    const correction = d.records.filter(r=>r.status==="correction").length;
    const today = localDateString();
    const todayAssignments = d.assignments.filter(a=>a.date===today);
    const unfinishedAssignments = d.assignments.filter(a=>{
      // 與總覽「作業處理進度」一致：今天與未來的作業尚未進入批改流程。
      if(a.date >= today || a.dashboardArchived) return false;
      const related = d.records.filter(r=>r.assignmentId===a.id);
      if(!d.students.length) return true;
      const completedStudents = new Set(
        related.filter(r=>r.status==="completed").map(r=>r.studentId)
      );
      return completedStudents.size < d.students.length;
    });
    return `
      <article class="class-card" onclick="enterClass('${cls.id}')">
        <h3>${escapeHtml(cls.name)}</h3>
        <div class="item-sub">${d.students.length} 位學生</div>
        <div class="class-overview-stats">
          <div class="class-stat">
            <span>今日作業</span>
            <strong>${todayAssignments.length}</strong>
            <small>項</small>
          </div>
          <div class="class-stat attention">
            <span>尚未處理完</span>
            <strong>${unfinishedAssignments.length}</strong>
            <small>項</small>
          </div>
        </div>
        <div class="class-card-meta">
          ${missing ? `<span class="badge missing">缺交 ${missing}</span>`:""}
          ${correction ? `<span class="badge correction">待訂正 ${correction}</span>`:""}
          ${(!missing && !correction && !unfinishedAssignments.length) ? `<span class="badge clear">目前無待處理</span>`:""}
        </div>
        <div class="class-card-actions single-action" onclick="event.stopPropagation()">
          <button class="primary enter-class-btn" onclick="enterClass('${cls.id}')">進入班級</button>
        </div>
      </article>
    `;
  }).join("");
}

function openAddClass(){
  showModal("新增班級", `
    <form id="newClassForm" class="modal-form">
      <label><span>班級名稱</span><input id="newClassName" placeholder="例如：六年甲班" required></label>
      <div class="modal-actions">
        <button type="button" class="secondary" onclick="closeModal()">取消</button>
        <button class="primary" type="submit">建立班級</button>
      </div>
    </form>
  `);
  document.getElementById("newClassForm").addEventListener("submit", e=>{
    e.preventDefault();
    const name = document.getElementById("newClassName").value.trim();
    const classData = defaultData();
    classData.class.name = name;
    const cls = {
      id:uid("c"),
      name,
      createdAt:new Date().toISOString(),
      data:classData
    };
    store.classes.push(cls);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    closeModal();
    renderClassHome();
    enterClass(cls.id);
  });
}


function openClassSettings(classId){
  const cls = store.classes.find(c=>c.id===classId);
  if(!cls) return;
  const d = normalizeData(cls.data);
  const rosterText = [...d.students]
    .sort((a,b)=>a.number-b.number)
    .map(s=>`${s.number} ${s.name}`)
    .join("\n");

  showModal("班級資料管理", `
    <form id="classSettingsForm" class="modal-form class-settings-form">
      <label>
        <span>班級名稱</span>
        <input id="homeClassNameInput" value="${escapeAttr(cls.name || "")}" required>
      </label>
      <label>
        <span>學生名單</span>
        <textarea id="homeStudentRosterInput" rows="12" placeholder="每行一位學生，例如：&#10;1 王小明&#10;2 李小華">${escapeHtml(rosterText)}</textarea>
      </label>

      <div class="settings-divider"></div>

      <div class="settings-block">
        <div>
          <div class="item-title">資料備份</div>
          <div class="item-sub">匯出或匯入這個班級的學生、作業與聯絡簿資料。</div>
        </div>
        <div class="settings-inline-actions">
          <button type="button" class="secondary" onclick="exportClassBackup('${classId}')">匯出 JSON</button>
          <label class="secondary file-button">
            匯入 JSON
            <input type="file" accept=".json,application/json" onchange="importClassBackup('${classId}', this.files[0]); this.value=''">
          </label>
        </div>
      </div>

      <div class="settings-divider"></div>

      <div class="settings-block danger-zone">
        <div>
          <div class="item-title">清除班級資料</div>
          <div class="item-sub">保留班級本身，但清除學生、作業、聯絡簿與追蹤紀錄。</div>
        </div>
        <button type="button" class="ghost-danger" onclick="clearClassFromHome('${classId}')">清除資料</button>
      </div>

      <div class="modal-actions">
        <button type="button" class="secondary" onclick="closeModal()">取消</button>
        <button class="primary" type="submit">儲存設定</button>
      </div>
    </form>
  `);

  document.getElementById("classSettingsForm").addEventListener("submit", e=>{
    e.preventDefault();
    const newName = document.getElementById("homeClassNameInput").value.trim();
    const roster = parseRoster(document.getElementById("homeStudentRosterInput").value);
    const oldByNumber = new Map(d.students.map(s=>[s.number,s]));

    d.class.name = newName;
    d.students = roster.map(s=>{
      const old = oldByNumber.get(s.number);
      return {id: old?.id || uid("s"), number:s.number, name:s.name};
    });

    // Ensure every assignment has a record for every current student.
    d.assignments.forEach(a=>{
      d.students.forEach(s=>{
        if(!d.records.some(r=>r.assignmentId===a.id && r.studentId===s.id)){
          d.records.push({assignmentId:a.id, studentId:s.id, status:"pending", note:""});
        }
      });
    });

    // Drop records belonging to students no longer in roster.
    const studentIds = new Set(d.students.map(s=>s.id));
    d.records = d.records.filter(r=>studentIds.has(r.studentId));
    d.scores = Object.fromEntries(
      Object.entries(d.scores || {}).filter(([studentId])=>studentIds.has(studentId))
    );
    d.groups = (d.groups || []).map(g=>({
      ...g,
      studentIds:(g.studentIds || []).filter(studentId=>studentIds.has(studentId))
    }));

    cls.name = newName;
    cls.data = d;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    closeModal();
    renderClassHome();
    toast("班級資料已儲存");
  });
}

function exportClassBackup(classId){
  const cls = store.classes.find(c=>c.id===classId);
  if(!cls) return;
  const payload = {
    app:"classroom-manager",
    version:APP_VERSION,
    backupDate:new Date().toISOString(),
    className:cls.name,
    data:normalizeData(cls.data)
  };
  const blob = new Blob([JSON.stringify(payload,null,2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${cls.name || "班級"}-作業追蹤備份-${localDateString()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importClassBackup(classId, file){
  if(!file) return;
  const cls = store.classes.find(c=>c.id===classId);
  if(!cls) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    try{
      const parsed = JSON.parse(reader.result);
      const incoming = normalizeData(parsed.data || parsed);
      const ok = confirm(`確定要匯入備份到「${cls.name}」嗎？\n\n目前班級資料會被備份內容取代。`);
      if(!ok) return;
      cls.data = incoming;
      if(parsed.className){
        cls.name = parsed.className;
        cls.data.class.name = parsed.className;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
      closeModal();
      renderClassHome();
      toast("班級備份已匯入");
    }catch(e){
      alert("匯入失敗：JSON 檔案格式不正確。");
    }
  };
  reader.readAsText(file);
}

function clearClassFromHome(classId){
  const cls = store.classes.find(c=>c.id===classId);
  if(!cls) return;
  if(!confirm(`確定要清除「${cls.name}」的所有班級資料嗎？`)) return;
  if(!confirm("再次確認：若沒有備份，清除後無法復原。")) return;
  const fresh = defaultData();
  fresh.class.name = cls.name;
  cls.data = fresh;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  closeModal();
  renderClassHome();
  toast("班級資料已清除");
}

function openClassDataPanel(){
  if(!store.classes.length){
    toast("目前還沒有班級");
    return;
  }
  const options = store.classes
    .map(c=>`<button class="class-manage-row" onclick="openClassSettings('${c.id}')"><span>${escapeHtml(c.name)}</span><span>管理 ›</span></button>`)
    .join("");
  showModal("班級資料管理", `<div class="class-manage-list">${options}</div>`);
}

function enterClass(classId){
  const cls = store.classes.find(c=>c.id===classId);
  if(!cls) return;
  activeClassId = classId;
  data = normalizeData(cls.data);
  data.class.name = cls.name || data.class.name;
  document.getElementById("classHome").classList.add("hidden");
  document.getElementById("workspace").classList.remove("hidden");
  setPage("dashboard");
}

function leaveClass(){
  persistActiveClass();
  unmountSeatModule();
  stopNoiseMonitor();
  activeClassId = null;
  document.getElementById("workspace").classList.add("hidden");
  document.getElementById("classHome").classList.remove("hidden");
  closeModal();
  renderClassHome();
}

function renameClass(classId){
  const cls = store.classes.find(c=>c.id===classId);
  if(!cls) return;
  const name = prompt("輸入新的班級名稱：", cls.name);
  if(name===null) return;
  const trimmed = name.trim();
  if(!trimmed) return;
  cls.name = trimmed;
  cls.data = normalizeData(cls.data);
  cls.data.class.name = trimmed;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  renderClassHome();
}

function renderPage(page=currentPage){
  __lastRenderedDate=localDateString();
  const today=document.getElementById("todayText");if(today)today.textContent=formatToday();
  const header=document.getElementById("headerClassName");if(header)header.textContent=data.class.name||"Classroom Manager";
  switch(page){
    case "dashboard":
      {const name=document.getElementById("dashboardClassName");if(name)name.textContent=data.class.name||"尚未設定班級";}
      renderDashboard();renderTodayNotices();renderMemoSummary();break;
    case "assignments":renderAssignments();break;
    case "contactbook":renderContactBook();break;
    case "students":renderStudents();break;
    case "seats":renderSeats();break;
    case "scores":
      if(currentScoreMode==="individual")renderScores();
      else if(currentScoreMode==="group")renderGroupScores();
      else if(currentScoreMode==="lottery")renderLottery();
      else if(currentScoreMode==="timer")renderPomodoro();
      else if(currentScoreMode==="marquee")renderMarquee();
      else if(currentScoreMode==="noise")renderNoiseTool();
      break;
    case "settings":renderSettingsRoster();break;
  }
}
function setPage(page){
  const previousPage=currentPage;
  if(previousPage==="seats" && page!=="seats") unmountSeatModule();
  currentPage = page;
  document.querySelectorAll(".page").forEach(el=>el.classList.toggle("active", el.id===page));
  document.querySelectorAll(".tab").forEach(el=>el.classList.toggle("active", el.dataset.page===page));
  if(page!=="scores") stopNoiseMonitor();
  renderPage(page);
}


let __lastRenderedDate = localDateString();

function refreshForDateRollover(){
  const currentDate = localDateString();
  if(currentDate === __lastRenderedDate) return;
  __lastRenderedDate = currentDate;
  if(activeClassId) renderPage(currentPage);
  else renderClassHome();
}

function startDateRolloverGuards(){
  // 第一層：頁面持續開啟時，定期檢查是否跨日。
  window.setInterval(refreshForDateRollover, 60000);

  // 第二層：從背景切回、重新聚焦時，立即檢查一次。
  document.addEventListener("visibilitychange", ()=>{
    if(document.visibilityState === "visible"){
      refreshForDateRollover();
    }else if(noiseActive){
      stopNoiseMonitor();
    }
  });
  window.addEventListener("focus", refreshForDateRollover);
}

function renderAll(){
  // v2.0.3：保留相容入口，但正式流程只繪製目前頁面。
  if(activeClassId) renderPage(currentPage);
  else renderClassHome();
}


function renderTodayNotices(){
  const area = document.getElementById("todayNoticeArea");
  if(!area) return;

  const today = localDateString();
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate()+1);
  const tomorrow = [
    tomorrowDate.getFullYear(),
    String(tomorrowDate.getMonth()+1).padStart(2,"0"),
    String(tomorrowDate.getDate()).padStart(2,"0")
  ].join("-");

  const notices = Array.isArray(data.notices) ? data.notices : [];
  const todayNotices = notices.filter(n=>n.date===today);
  const tomorrowNotices = notices.filter(n=>n.date===tomorrow);

  const shortDate = dateString => {
    const [,month,day] = dateString.split("-");
    return `${Number(month)}/${Number(day)}`;
  };

  const noticeColumn = (label,dateString,items,kind) => `
    <div class="notice-day-column ${kind}">
      <div class="notice-day-head">
        <span class="notice-day-label">${label}</span>
        <span class="notice-day-date">${shortDate(dateString)}</span>
      </div>
      <div class="notice-day-list">
        ${items.length
          ? items.map(n=>`<div class="notice-line">${escapeHtml(n.text)}</div>`).join("")
          : `<div class="notice-empty">${label}無公告</div>`}
      </div>
    </div>
  `;

  area.innerHTML = `
    <div class="notice-preview-grid">
      ${noticeColumn("今日",today,todayNotices,"today")}
      ${noticeColumn("明日",tomorrow,tomorrowNotices,"tomorrow")}
    </div>
  `;
}


function memoDaysLeft(deadline){
  if(!deadline) return null;
  const [y,m,d]=deadline.split("-").map(Number);
  if(!y || !m || !d) return null;
  const target=new Date(y,m-1,d);
  const now=new Date();
  const today=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  return Math.ceil((target-today)/86400000);
}

function memoDeadlineLabel(deadline){
  const left=memoDaysLeft(deadline);
  if(left===null) return "未設定截止日";
  if(left<0) return `已逾期 ${Math.abs(left)} 天`;
  if(left===0) return "今天截止";
  if(left===1) return "明天截止";
  return `剩 ${left} 天`;
}


function memoSortValue(memo){
  const left=memoDaysLeft(memo?.deadline);
  if(left===null) return [3, Number.POSITIVE_INFINITY];
  if(left<0) return [0, Math.abs(left)];
  if(left===0) return [1, 0];
  return [2, left];
}

function compareMemosByDeadline(a,b){
  const av=memoSortValue(a);
  const bv=memoSortValue(b);
  return av[0]-bv[0] || av[1]-bv[1] || (a.deadline || "9999-12-31").localeCompare(b.deadline || "9999-12-31") || (a.createdAt || "").localeCompare(b.createdAt || "");
}

function renderMemoSummary(){
  const list=document.getElementById("memoSummaryList");
  const count=document.getElementById("memoCount");
  if(!list || !count) return;
  const memos=[...(Array.isArray(data.memos) ? data.memos : [])]
    .filter(m=>String(m.text || "").trim())
    .sort(compareMemosByDeadline);
  count.textContent=`${memos.length} 項`;
  if(!memos.length){
    list.innerHTML=`<div class="memo-summary-empty">目前沒有備忘事項</div>`;
    return;
  }
  list.innerHTML=memos.slice(0,4).map(m=>`
    <div class="memo-summary-item">
      <button class="memo-complete-btn" type="button" onclick="completeMemo('${m.id}')" aria-label="完成並移除 ${escapeAttr(m.text)}" title="完成並移除">✓</button>
      <div class="memo-summary-main">
        <div class="memo-summary-text">${escapeHtml(m.text)}</div>
        <div class="memo-summary-deadline ${memoDaysLeft(m.deadline)<0 ? "overdue" : ""}">${escapeHtml(memoDeadlineLabel(m.deadline))}</div>
      </div>
    </div>
  `).join("") + (memos.length>4 ? `<div class="memo-summary-more">另有 ${memos.length-4} 項，請至「設定」查看</div>` : "");
}

function completeMemo(memoId){
  const memo=(data.memos || []).find(m=>m.id===memoId);
  if(!memo) return;
  if(!confirm(`「${memo.text}」已完成並從備忘錄移除嗎？`)) return;
  data.memos=(data.memos || []).filter(m=>m.id!==memoId);
  saveData();
  renderMemoSummary();
  toast("備忘事項已完成");
}

function addMemoFromSettings(){
  const deadline=document.getElementById("memoDeadline")?.value || "";
  const text=document.getElementById("memoText")?.value.trim() || "";
  if(!deadline || !text){ toast("請輸入備忘事項與截止日"); return; }
  if(!Array.isArray(data.memos)) data.memos=[];
  data.memos.push({id:uid("m"),deadline,text,createdAt:new Date().toISOString()});
  saveData();
  renderMemoSummary();
  closeModal();
  openNoticeMemo();
  toast("備忘事項已新增");
}

function editMemo(memoId){
  const memo=(data.memos || []).find(m=>m.id===memoId);
  if(!memo) return;
  showModal("編輯備忘錄",`
    <form id="editMemoForm" class="modal-form">
      <label><span>截止日</span><input type="date" id="editMemoDeadline" value="${escapeAttr(memo.deadline || localDateString())}" required></label>
      <label><span>事項</span><input id="editMemoText" value="${escapeAttr(memo.text || "")}" required></label>
      <div class="modal-actions">
        <button type="button" class="secondary" onclick="closeModal();openNoticeMemo()">取消</button>
        <button class="primary" type="submit">儲存</button>
      </div>
    </form>`);
  document.getElementById("editMemoForm").addEventListener("submit",e=>{
    e.preventDefault();
    const nextDeadline=document.getElementById("editMemoDeadline").value;
    const nextText=document.getElementById("editMemoText").value.trim();
    if(!nextDeadline || !nextText){ toast("請輸入備忘事項與截止日"); return; }
    memo.deadline=nextDeadline;
    memo.text=nextText;
    saveData(); closeModal(); renderMemoSummary(); openNoticeMemo();
    toast("備忘事項已更新");
  });
}

function deleteMemo(memoId){
  if(!confirm("確定要刪除這則備忘事項嗎？")) return;
  data.memos=(data.memos || []).filter(m=>m.id!==memoId);
  saveData(); closeModal(); renderMemoSummary(); openNoticeMemo();
}

function openNoticeMemo(){
  const notices=[...(data.notices || [])]
    .sort((a,b)=> b.date.localeCompare(a.date) || (b.createdAt || "").localeCompare(a.createdAt || ""));
  const memos=[...(data.memos || [])]
    .sort(compareMemosByDeadline);

  const noticeRows=notices.length ? notices.map(n=>`
    <article class="settings-item-card">
      <div class="settings-item-date"><span class="settings-item-date-label">顯示日</span>${formatDate(n.date)}</div>
      <div class="settings-item-body">
        <div class="settings-item-text">${escapeHtml(n.text)}</div>
      </div>
      <div class="settings-item-actions">
        <button class="secondary small-btn" type="button" onclick="editNotice('${n.id}')">編輯</button>
        <button class="ghost-danger small-btn" type="button" onclick="deleteNotice('${n.id}')">刪除</button>
      </div>
    </article>`).join("") : `<div class="settings-list-empty">目前還沒有公告。</div>`;

  const memoRows=memos.length ? memos.map(m=>`
    <article class="settings-item-card ${memoDaysLeft(m.deadline)<0 ? "is-overdue" : ""}">
      <div class="settings-item-date"><span class="settings-item-date-label">截止日</span>${formatDate(m.deadline)}</div>
      <div class="settings-item-body">
        <div class="settings-item-text">${escapeHtml(m.text)}</div>
        <div class="settings-item-status ${memoDaysLeft(m.deadline)<0 ? "memo-overdue-text" : ""}">${escapeHtml(memoDeadlineLabel(m.deadline))}</div>
      </div>
      <div class="settings-item-actions">
        <button class="secondary small-btn" type="button" onclick="editMemo('${m.id}')">編輯</button>
        <button class="ghost-danger small-btn" type="button" onclick="deleteMemo('${m.id}')">刪除</button>
      </div>
    </article>`).join("") : `<div class="settings-list-empty">目前還沒有備忘事項。</div>`;

  showModal("設定",`
    <div class="settings-hub settings-hub-polished">
      <section class="settings-panel">
        <div class="settings-panel-head">
          <div>
            <div class="settings-panel-kicker">ANNOUNCEMENT</div>
            <div class="settings-panel-title">公告設定</div>
            <div class="settings-panel-desc">指定日期的公告只會在當天顯示於總覽。</div>
          </div>
          <span class="settings-panel-count">${notices.length} 則</span>
        </div>

        <form id="newNoticeForm" class="settings-compose-card">
          <div class="settings-compose-grid">
            <label class="settings-field compact-field">
              <span>顯示日期</span>
              <input type="date" id="noticeDate" value="${localDateString()}" required>
            </label>
            <label class="settings-field">
              <span>公告內容</span>
              <input id="noticeText" placeholder="例如：藝術深耕" required>
            </label>
            <button class="primary settings-add-btn" type="submit">＋ 新增公告</button>
          </div>
        </form>

        <div class="settings-list-head">
          <span>已設定公告</span>
          <span>依日期由新到舊</span>
        </div>
        <div class="settings-item-list">${noticeRows}</div>
      </section>

      <section class="settings-panel memo-panel">
        <div class="settings-panel-head">
          <div>
            <div class="settings-panel-kicker">MEMO</div>
            <div class="settings-panel-title">備忘事項</div>
            <div class="settings-panel-desc">依截止日排序，越接近截止日期越靠上。</div>
          </div>
          <span class="settings-panel-count">${memos.length} 項</span>
        </div>

        <div class="settings-compose-card">
          <div class="settings-compose-grid">
            <label class="settings-field compact-field">
              <span>截止日</span>
              <input type="date" id="memoDeadline" value="${localDateString()}" required>
            </label>
            <label class="settings-field">
              <span>事項</span>
              <input id="memoText" placeholder="例如：作業抽查" required>
            </label>
            <button class="primary settings-add-btn" type="button" onclick="addMemoFromSettings()">＋ 新增備忘</button>
          </div>
        </div>

        <div class="settings-list-head">
          <span>待辦事項</span>
          <span>依截止日排序</span>
        </div>
        <div class="settings-item-list">${memoRows}</div>
      </section>
    </div>`);

  document.getElementById("newNoticeForm").addEventListener("submit",e=>{
    e.preventDefault();
    const date=document.getElementById("noticeDate").value;
    const text=document.getElementById("noticeText").value.trim();
    if(!date || !text){ toast("請輸入公告日期與內容"); return; }
    if(!Array.isArray(data.notices)) data.notices=[];
    data.notices.push({id:uid("n"),date,text,createdAt:new Date().toISOString()});
    saveData(); closeModal(); renderTodayNotices(); openNoticeMemo();
    toast("公告已新增");
  });
}

function editNotice(noticeId){
  const notice=(data.notices || []).find(n=>n.id===noticeId);
  if(!notice) return;
  showModal("編輯公告",`
    <form id="editNoticeForm" class="modal-form">
      <label>
        <span>顯示日期</span>
        <input type="date" id="editNoticeDate" value="${escapeAttr(notice.date || localDateString())}" required>
      </label>
      <label>
        <span>注意事項</span>
        <input id="editNoticeText" value="${escapeAttr(notice.text || "")}" required>
      </label>
      <div class="modal-actions">
        <button type="button" class="secondary" onclick="closeModal();openNoticeMemo()">取消</button>
        <button class="primary" type="submit">儲存</button>
      </div>
    </form>
  `);

  document.getElementById("editNoticeForm").addEventListener("submit",e=>{
    e.preventDefault();
    const nextDate=document.getElementById("editNoticeDate").value;
    const nextText=document.getElementById("editNoticeText").value.trim();
    if(!nextDate || !nextText){ toast("請輸入公告日期與內容"); return; }
    notice.date=nextDate;
    notice.text=nextText;
    saveData();
    closeModal();
    renderTodayNotices();
    openNoticeMemo();
    toast("公告已更新");
  });
}

function deleteNotice(noticeId){
  const notice=(data.notices || []).find(n=>n.id===noticeId);
  if(!notice) return;
  if(!confirm(`確定要刪除 ${formatDate(notice.date)} 的這則公告嗎？`)) return;
  data.notices=(data.notices || []).filter(n=>n.id!==noticeId);
  saveData();
  closeModal();
  renderTodayNotices();
  openNoticeMemo();
}

function renderDashboard(){
  const missing = data.records.filter(r=>r.status==="missing");
  const correction = data.records.filter(r=>r.status==="correction");
  document.getElementById("missingCount").textContent = missing.length;
  document.getElementById("missingPeople").textContent = `${new Set(missing.map(r=>r.studentId)).size} 人`;
  document.getElementById("correctionCount").textContent = correction.length;
  document.getElementById("correctionPeople").textContent = `${new Set(correction.map(r=>r.studentId)).size} 人`;

  const today = localDateString();
  const activeAssignments = [...data.assignments]
    // 作業於隔天才進入「作業處理進度」：只顯示今天以前的作業。
    .filter(a=>!a.dashboardArchived && a.date < today)
    .sort((a,b)=> b.date.localeCompare(a.date) || (b.createdAt || "").localeCompare(a.createdAt || ""));
  const target = document.getElementById("recentAssignments");
  if(!activeAssignments.length){
    target.innerHTML = `<div class="empty cheerful">🎉 目前沒有需要追蹤的作業，全部處理完畢！</div>`;
  }else{
    target.innerHTML = activeAssignments.map(a=>dashboardAssignmentHtml(a)).join("");
  }

  // 「近期繳交狀況」：今天新出的作業隔天才進入批改流程。
  // 從今天以前、尚未自總覽封存的作業中，找出最近一個作業日期，
  // 並把該日期的所有作業直接展開成學生狀態管理介面。
  const submissionTarget = document.getElementById("submissionOverview");
  const eligibleForSubmission = [...data.assignments]
    .filter(a=>!a.dashboardArchived && a.date < today)
    .sort((a,b)=>b.date.localeCompare(a.date) || (b.createdAt || "").localeCompare(a.createdAt || ""));
  const latestSubmissionDate = eligibleForSubmission[0]?.date || "";
  const latestAssignments = latestSubmissionDate
    ? eligibleForSubmission.filter(a=>a.date===latestSubmissionDate)
    : [];

  const hint = document.getElementById("submissionOverviewHint");
  if(hint){
    hint.textContent = latestSubmissionDate
      ? `${formatDate(latestSubmissionDate)}｜最近一批應批改作業，可直接修改學生狀態`
      : "目前沒有今天以前、需要批改的作業";
  }
  if(!submissionTarget) return;
  if(!latestAssignments.length){
    submissionTarget.innerHTML = `<div class="empty cheerful">🎉 目前沒有需要批改的作業。</div>`;
  }else{
    submissionTarget.innerHTML = latestAssignments.map(a=>submissionOverviewHtml(a)).join("");
  }
}


function submissionOverviewHtml(a){
  const {counts:c,total,percent}=assignmentProgress(a.id);
  const students=assignmentSortedStudents();
  return `
    <article class="submission-overview-card">
      <div class="submission-overview-title">
        <div>
          <div class="item-title">${escapeHtml(a.title)}</div>
          <div class="item-sub">${formatDate(a.date)} · 完成 ${c.completed} / ${total}</div>
        </div>
        <div class="rate-pill ${percent===100 ? "done" : ""}">${percent}%</div>
      </div>
      <div class="submission-student-grid ${assignmentStudentSortMode==="group"?"grouped":""}">
        ${assignmentStudentSortMode==="group"
          ? (()=>{const buckets=[];students.forEach(s=>{const g=assignmentGroupForStudent(s.id),key=g?.id||"ungrouped";let b=buckets.find(x=>x.key===key);if(!b){b={key,label:g?.name||"未分組",students:[]};buckets.push(b)}b.students.push(s)});return buckets.map(b=>`<section class="submission-group-section"><div class="assignment-group-heading">${escapeHtml(b.label)}</div><div class="submission-group-cells">${b.students.map(s=>{const r=ensureRecord(a.id,s.id);return `<label class="submission-student-cell"><span class="submission-student-name">${escapeHtml(String(s.number).padStart(2,"0"))} ${escapeHtml(s.name)}</span><select class="status-select ${r.status}" aria-label="${escapeAttr(s.name)}的作業狀態" onchange="setStatus('${a.id}','${s.id}',this)">${STATUS_ORDER.map(status=>`<option value="${status}" ${r.status===status?"selected":""}>${STATUS_LABEL[status]}</option>`).join("")}</select></label>`}).join("")}</div></section>`).join("")})()
          : students.map(s=>{const r=ensureRecord(a.id,s.id);return `<label class="submission-student-cell"><span class="submission-student-name">${escapeHtml(String(s.number).padStart(2,"0"))} ${escapeHtml(s.name)}</span><select class="status-select ${r.status}" aria-label="${escapeAttr(s.name)}的作業狀態" onchange="setStatus('${a.id}','${s.id}',this)">${STATUS_ORDER.map(status=>`<option value="${status}" ${r.status===status?"selected":""}>${STATUS_LABEL[status]}</option>`).join("")}</select></label>`}).join("")}
      </div>
    </article>`;
}

function dashboardAssignmentHtml(a){
  const {counts:c, total, percent} = assignmentProgress(a.id);
  return `
    <div class="progress-card clickable" onclick="openAssignment('${a.id}')">
      <div class="progress-card-top">
        <div class="item-main">
          <div class="item-title">${escapeHtml(a.title)}</div>
          <div class="item-sub">${formatDate(a.date)}</div>
        </div>
        <div class="rate-pill ${percent===100 ? "done" : ""}">${percent}%</div>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${percent}%"></div></div>
      <div class="progress-meta">
        <span>完成 ${c.completed} / ${total}</span>
        <span>${c.missing ? `缺交 ${c.missing}` : "無缺交"} · ${c.correction ? `待訂正 ${c.correction}` : "無待訂正"}</span>
      </div>
    </div>`;
}

function assignmentCardHtml(a){
  const c = assignmentCounts(a.id);
  return `
    <div class="item-card clickable" onclick="openAssignment('${a.id}')">
      <div class="item-main">
        <div class="item-title">${escapeHtml(a.title)}</div>
        <div class="item-sub">${formatDate(a.date)}</div>
        <div class="assignment-summary">
          ${c.missing ? `<span class="badge missing">缺交 ${c.missing}</span>`:""}
          ${c.correction ? `<span class="badge correction">待訂正 ${c.correction}</span>`:""}
          ${c.completed ? `<span class="badge completed">完成 ${c.completed}</span>`:""}
          ${c.pending ? `<span class="badge pending">未確認 ${c.pending}</span>`:""}
        </div>
      </div>
      <span>›</span>
    </div>`;
}

function renderAssignments(){
  const input = document.getElementById("assignmentDateFilter");
  if(!input.value) input.value = localDateString();

  let items = [...data.assignments].sort((a,b)=> b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  if(!showAllAssignmentsMode){
    items = items.filter(a=>a.date===input.value);
  }
  const list = document.getElementById("assignmentList");
  if(!items.length){
    list.innerHTML = `<div class="empty">${showAllAssignmentsMode ? "尚未建立任何作業。" : "這一天尚未建立作業。"}</div>`;
  }else{
    list.innerHTML = items.map(a=>assignmentCardHtml(a)).join("");
  }
}


function renderContactBook(){
  const input = document.getElementById("contactDateFilter");
  if(!input) return;
  if(!input.value) input.value = localDateString();

  let items = [...data.contactItems].sort((a,b)=> b.date.localeCompare(a.date) || (a.order??0)-(b.order??0) || a.createdAt.localeCompare(b.createdAt));
  if(!showAllContactItemsMode){
    items = items.filter(i=>i.date===input.value);
  }

  const list = document.getElementById("contactItemList");
  if(!items.length){
    list.innerHTML = `<div class="empty">${showAllContactItemsMode ? "尚未建立任何聯絡事項。" : "這一天尚未建立聯絡事項。"}</div>`;
    return;
  }

  list.innerHTML = items.map(i=>{
    const linked = i.assignmentId && data.assignments.some(a=>a.id===i.assignmentId);
    return `
      <div class="contact-card">
        <div class="contact-card-main">
          <div class="contact-date">${formatDate(i.date)} <span class="contact-order-label">第 ${contactOrderIndex(i)+1} 項</span></div>
          <div class="item-title">${escapeHtml(i.title)}</div>
          ${i.note ? `<div class="item-sub">${escapeHtml(i.note)}</div>` : ""}
        </div>
        <div class="contact-actions">
          <label class="assignment-toggle">
            <input type="checkbox" ${i.trackAsAssignment && linked ? "checked" : ""}
              onchange="toggleContactAssignment('${i.id}', this.checked, this)" />
            <span>登錄到作業</span>
          </label>
          ${linked ? `<button class="secondary small-btn" onclick="openAssignment('${i.assignmentId}')">查看作業</button>` : ""}
          <button class="secondary small-btn" onclick="editContactItem('${i.id}')">編輯</button>
          <button class="secondary small-btn contact-move-btn" onclick="moveContactItem('${i.id}',-1)" ${contactOrderIndex(i)===0?"disabled":""} title="往前移">↑</button>
          <button class="secondary small-btn contact-move-btn" onclick="moveContactItem('${i.id}',1)" ${contactOrderIndex(i)===contactItemsForDate(i.date).length-1?"disabled":""} title="往後移">↓</button>
          <button class="ghost-danger small-btn" onclick="deleteContactItem('${i.id}')">刪除</button>
        </div>
      </div>`;
  }).join("");
}

function contactItemsForDate(date){
  return data.contactItems.filter(i=>i.date===date).sort((a,b)=>(a.order??0)-(b.order??0)||a.createdAt.localeCompare(b.createdAt));
}
function normalizeContactOrder(date){
  contactItemsForDate(date).forEach((item,index)=>item.order=index);
}
function contactOrderIndex(item){return Math.max(0,contactItemsForDate(item.date).findIndex(i=>i.id===item.id))}
function moveContactItem(contactId,direction){
  const item=data.contactItems.find(i=>i.id===contactId);if(!item)return;
  const items=contactItemsForDate(item.date),index=items.findIndex(i=>i.id===contactId),target=index+direction;
  if(index<0||target<0||target>=items.length)return;
  [items[index].order,items[target].order]=[items[target].order??target,items[index].order??index];
  normalizeContactOrder(item.date);saveData();renderContactBook();
}
function editContactItem(contactId){
  const item=data.contactItems.find(i=>i.id===contactId);if(!item)return;
  showModal("編輯聯絡事項",`
    <form id="editContactItemForm" class="modal-form">
      <label><span>日期</span><input type="date" id="editContactDate" value="${escapeAttr(item.date)}" required></label>
      <label><span>事項</span><input id="editContactTitle" value="${escapeAttr(item.title)}" required></label>
      <label><span>補充說明</span><input id="editContactNote" value="${escapeAttr(item.note||"")}" placeholder="選填"></label>
      <div class="modal-actions"><button type="button" class="secondary" onclick="closeModal()">取消</button><button class="primary" type="submit">儲存修改</button></div>
    </form>`);
  document.getElementById("editContactItemForm").addEventListener("submit",e=>{
    e.preventDefault();const oldDate=item.date,newDate=document.getElementById("editContactDate").value;
    item.date=newDate;item.title=document.getElementById("editContactTitle").value.trim();item.note=document.getElementById("editContactNote").value.trim();
    if(!item.title){toast("請輸入聯絡事項");return}
    const linked=data.assignments.find(a=>a.id===item.assignmentId);
    if(linked){linked.date=item.date;linked.title=item.title}
    if(oldDate!==newDate){normalizeContactOrder(oldDate);item.order=contactItemsForDate(newDate).filter(i=>i.id!==item.id).length}
    normalizeContactOrder(newDate);saveData();closeModal();renderContactBook();renderAssignments();renderDashboard();toast("聯絡事項已更新");
  });
}

function contactDraftRowHtml(index){
  return `
    <div class="contact-draft-row" data-contact-row>
      <div class="contact-draft-number">${index + 1}</div>
      <div class="contact-draft-fields">
        <label>
          <span>事項</span>
          <input class="contact-draft-title" placeholder="例如：數學習作 P.42" required>
        </label>
        <label>
          <span>補充說明</span>
          <input class="contact-draft-note" placeholder="選填">
        </label>
        <label class="check-row contact-track-row">
          <input type="checkbox" class="contact-draft-track">
          <span>登錄到作業</span>
        </label>
      </div>
      <button type="button" class="contact-row-remove" title="移除此項" onclick="removeContactDraftRow(this)">×</button>
    </div>
  `;
}

function refreshContactDraftNumbers(){
  const rows = [...document.querySelectorAll("[data-contact-row]")];
  rows.forEach((row,index)=>{
    const num = row.querySelector(".contact-draft-number");
    if(num) num.textContent = index + 1;
    const remove = row.querySelector(".contact-row-remove");
    if(remove) remove.style.visibility = rows.length === 1 ? "hidden" : "visible";
  });
}

function addContactDraftRow(){
  const list = document.getElementById("contactDraftList");
  if(!list) return;
  const holder = document.createElement("div");
  holder.innerHTML = contactDraftRowHtml(list.querySelectorAll("[data-contact-row]").length).trim();
  list.appendChild(holder.firstElementChild);
  refreshContactDraftNumbers();
  const inputs = list.querySelectorAll(".contact-draft-title");
  inputs[inputs.length - 1]?.focus();
}

function removeContactDraftRow(button){
  const row = button.closest("[data-contact-row]");
  if(!row) return;
  const rows = document.querySelectorAll("[data-contact-row]");
  if(rows.length <= 1) return;
  row.remove();
  refreshContactDraftNumbers();
}

function openNewContactItem(){
  showModal(
    "新增聯絡事項",
    `
      <form id="newContactItemForm" class="modal-form contact-batch-form">
        <label class="contact-date-field">
          <span>日期</span>
          <input type="date" id="contactNewDate" value="${localDateString()}" required>
        </label>

        <div id="contactDraftList" class="contact-draft-list">
          ${contactDraftRowHtml(0)}
        </div>

        <button type="button" class="add-contact-row-btn" onclick="addContactDraftRow()">
          <span class="plus-symbol">＋</span>
          <span>新增一項</span>
        </button>

        <div class="modal-actions">
          <button type="button" class="secondary" onclick="closeModal()">取消</button>
          <button class="primary" type="submit">儲存聯絡簿</button>
        </div>
      </form>
    `
  );

  refreshContactDraftNumbers();

  document.getElementById("newContactItemForm").addEventListener("submit", e=>{
    e.preventDefault();
    const date = document.getElementById("contactNewDate").value;
    const rows = [...document.querySelectorAll("[data-contact-row]")];
    const drafts = rows.map(row=>({
      title:row.querySelector(".contact-draft-title").value.trim(),
      note:row.querySelector(".contact-draft-note").value.trim(),
      trackAsAssignment:row.querySelector(".contact-draft-track").checked
    })).filter(x=>x.title);

    if(!drafts.length){
      toast("請至少輸入一項聯絡事項");
      return;
    }

    if(drafts.some(x=>x.trackAsAssignment) && !data.students.length){
      toast("要登錄為作業前，請先到班級首頁的「班級資料管理」建立學生名單");
      return;
    }

    drafts.forEach(draft=>{
      const item = {
        id:uid("c"),
        date,
        title:draft.title,
        note:draft.note,
        subject:"",
        trackAsAssignment:draft.trackAsAssignment,
        assignmentId:null,
        order:contactItemsForDate(date).length,
        createdAt:new Date().toISOString()
      };
      if(item.trackAsAssignment){
        const assignment = createAssignmentFromContact(item);
        item.assignmentId = assignment.id;
      }
      data.contactItems.push(item);
    });

    const contactFilter = document.getElementById("contactDateFilter");
    if(contactFilter) contactFilter.value = date;
    showAllContactItemsMode = false;
    const allContactBtn = document.getElementById("showAllContactItems");
    if(allContactBtn) allContactBtn.textContent = "顯示全部";

    saveData();
    closeModal();
    renderContactBook();

    const trackedCount = drafts.filter(x=>x.trackAsAssignment).length;
    toast(trackedCount
      ? `已新增 ${drafts.length} 項，其中 ${trackedCount} 項同步到作業`
      : `已新增 ${drafts.length} 項聯絡事項`);
  });
}

function createAssignmentFromContact(item){
  const assignment = {
    id:uid("a"),
    date:item.date,
    subject:"",
    title:item.title,
    createdAt:new Date().toISOString(),
    dashboardArchived:false,
    sourceContactId:item.id
  };
  data.assignments.push(assignment);
  data.students.forEach(s=>{
    data.records.push({assignmentId:assignment.id, studentId:s.id, status:"pending", note:""});
  });
  return assignment;
}

function toggleContactAssignment(contactId, checked, checkbox){
  const item = data.contactItems.find(i=>i.id===contactId);
  if(!item) return;

  if(checked){
    if(!data.students.length){
      checkbox.checked = false;
      toast("請先到設定建立學生名單");
      return;
    }
    if(!item.assignmentId || !data.assignments.some(a=>a.id===item.assignmentId)){
      const assignment = createAssignmentFromContact(item);
      item.assignmentId = assignment.id;
    }
    item.trackAsAssignment = true;
    saveData();
    toast("已同步到作業追蹤");
    return;
  }

  const linkedAssignment = data.assignments.find(a=>a.id===item.assignmentId);
  if(linkedAssignment){
    const hasProgress = data.records.some(r=>r.assignmentId===linkedAssignment.id && r.status!=="pending");
    const message = hasProgress
      ? `這筆連動作業已經有學生追蹤紀錄。\n\n取消「登錄到作業」會刪除該作業及其所有學生狀態，確定要繼續嗎？`
      : `確定取消這筆聯絡事項的作業追蹤嗎？\n\n對應作業會從作業頁移除。`;
    if(!confirm(message)){
      checkbox.checked = true;
      return;
    }
    data.assignments = data.assignments.filter(a=>a.id!==linkedAssignment.id);
    data.records = data.records.filter(r=>r.assignmentId!==linkedAssignment.id);
  }
  item.trackAsAssignment = false;
  item.assignmentId = null;
  saveData();
  toast("已取消作業追蹤");
}

function deleteContactItem(contactId){
  const item = data.contactItems.find(i=>i.id===contactId);
  if(!item) return;
  const linkedAssignment = data.assignments.find(a=>a.id===item.assignmentId);
  let message = "確定要刪除這筆聯絡事項嗎？";
  if(linkedAssignment) message += "\n\n它目前有連動作業，連動作業與學生追蹤紀錄也會一起刪除。";
  if(!confirm(message)) return;
  if(linkedAssignment){
    data.assignments = data.assignments.filter(a=>a.id!==linkedAssignment.id);
    data.records = data.records.filter(r=>r.assignmentId!==linkedAssignment.id);
  }
  data.contactItems = data.contactItems.filter(i=>i.id!==contactId);
  normalizeContactOrder(item.date);
  saveData();
  toast("聯絡事項已刪除");
}



let currentScoreMode = "individual";

function setScoreMode(mode){
  if(currentScoreMode==="noise"&&mode!=="noise")stopNoiseMonitor();
  currentScoreMode = mode;
  document.querySelectorAll(".score-mode-tab").forEach(btn=>{
    btn.classList.toggle("active", btn.dataset.scoreMode===mode);
  });
  document.getElementById("individualScorePanel")?.classList.toggle("hidden", mode!=="individual");
  document.getElementById("groupScorePanel")?.classList.toggle("hidden", mode!=="group");
  document.getElementById("lotteryPanel")?.classList.toggle("hidden", mode!=="lottery");
  document.getElementById("timerPanel")?.classList.toggle("hidden", mode!=="timer");
  document.getElementById("marqueePanel")?.classList.toggle("hidden", mode!=="marquee");
  document.getElementById("noisePanel")?.classList.toggle("hidden", mode!=="noise");
  if(mode!=="noise") stopNoiseMonitor();
  if(mode==="group") renderGroupScores();
  if(mode==="lottery") renderLottery();
  if(mode==="timer") renderPomodoro();
  if(mode==="marquee") renderMarquee();
  if(mode==="noise") renderNoiseTool();
}


// v3.18 classroom tools: lottery + pomodoro
let lotteryDrawnIds = [];
let lotteryLastStudentId = null;
let lotteryClassId = null;
let lotteryMode = "without-replacement";

function ensureLotteryClass(){
  if(lotteryClassId === activeClassId) return;
  lotteryClassId = activeClassId;
  lotteryDrawnIds = [];
  lotteryLastStudentId = null;
}

function resetLottery(){
  ensureLotteryClass();
  lotteryDrawnIds = [];
  lotteryLastStudentId = null;
  renderLottery();
}

function drawRandomStudent(){
  ensureLotteryClass();
  const students = [...data.students].sort((a,b)=>Number(a.number)-Number(b.number));
  if(!students.length){
    toast("請先建立學生名單");
    return;
  }
  const validIds = new Set(students.map(s=>s.id));
  lotteryDrawnIds = lotteryDrawnIds.filter(id=>validIds.has(id));

  let pool;
  if(lotteryMode==="with-replacement"){
    // 抽後放回：每一次都從完整學生名單重新抽取，同一人可重複出現。
    pool=students;
  }else{
    pool=students.filter(s=>!lotteryDrawnIds.includes(s.id));
    if(!pool.length){
      toast("本輪已全部抽完，請先重置抽籤");
      return;
    }
  }

  const picked=pool[Math.floor(Math.random()*pool.length)];
  lotteryDrawnIds.push(picked.id);
  lotteryLastStudentId=picked.id;
  renderLottery();
}

function renderLottery(){
  const stage=document.getElementById("lotteryStage");
  if(!stage) return;
  ensureLotteryClass();
  const students=[...data.students].sort((a,b)=>Number(a.number)-Number(b.number));
  const validIds=new Set(students.map(s=>s.id));
  lotteryDrawnIds=lotteryDrawnIds.filter(id=>validIds.has(id));
  if(lotteryLastStudentId && !validIds.has(lotteryLastStudentId)) lotteryLastStudentId=null;

  document.querySelectorAll(".lottery-mode-btn").forEach(btn=>{
    btn.classList.toggle("active",btn.dataset.lotteryMode===lotteryMode);
  });
  const desc=document.getElementById("lotteryDescription");
  const remainingEl=document.getElementById("lotteryRemaining");
  const countEl=document.getElementById("lotteryDrawnCount");
  if(lotteryMode==="with-replacement"){
    if(desc) desc.textContent="每次都從全班重新抽取，抽過的學生仍可能再次被抽到。";
    if(remainingEl) remainingEl.textContent=`全班 ${students.length} 人`;
    if(countEl) countEl.textContent=`已抽 ${lotteryDrawnIds.length} 次`;
  }else{
    const uniqueDrawn=new Set(lotteryDrawnIds).size;
    const remaining=Math.max(0,students.length-uniqueDrawn);
    if(desc) desc.textContent="本輪採不重複抽取，抽完後可重置重新開始。";
    if(remainingEl) remainingEl.textContent=`${remaining} 人待抽`;
    if(countEl) countEl.textContent=`已抽 ${uniqueDrawn} 人`;
  }

  const last=students.find(s=>s.id===lotteryLastStudentId);
  stage.innerHTML=last
    ? `<div class="lottery-result"><span>${String(last.number).padStart(2,"0")} 號</span><strong>${escapeHtml(last.name)}</strong></div>`
    : students.length
      ? `<div class="lottery-placeholder">按下「抽一位」開始</div>`
      : `<div class="lottery-placeholder">尚未建立學生名單</div>`;

  const history=document.getElementById("lotteryHistory");
  if(history){
    const drawn=[...lotteryDrawnIds].reverse().map(id=>students.find(s=>s.id===id)).filter(Boolean);
    history.innerHTML=drawn.length
      ? drawn.map((s,i)=>`<div class="lottery-history-item"><span>${lotteryDrawnIds.length-i}</span><b>${String(s.number).padStart(2,"0")} 號</b><span>${escapeHtml(s.name)}</span></div>`).join("")
      : `<div class="empty compact">本輪尚未抽出學生</div>`;
  }
  const drawBtn=document.getElementById("drawStudentBtn");
  if(drawBtn){
    const noRemaining=lotteryMode==="without-replacement" && students.length>0 && new Set(lotteryDrawnIds).size>=students.length;
    drawBtn.disabled=!students.length || noRemaining;
  }
}

let pomodoroDurationSec=25*60;
let pomodoroRemainingSec=25*60;
let pomodoroRunning=false;
let pomodoroEndAt=null;
let pomodoroInterval=null;
let pomodoroLabel="專注時間";

function formatTimer(seconds){
  const safe=Math.max(0,Math.ceil(seconds));
  const m=Math.floor(safe/60);
  const s=safe%60;
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function stopPomodoroInterval(){
  if(pomodoroInterval){
    clearInterval(pomodoroInterval);
    pomodoroInterval=null;
  }
}

function syncPomodoroRemaining(){
  if(pomodoroRunning && pomodoroEndAt){
    pomodoroRemainingSec=Math.max(0,Math.ceil((pomodoroEndAt-Date.now())/1000));
    if(pomodoroRemainingSec<=0){
      pomodoroRunning=false;
      pomodoroEndAt=null;
      stopPomodoroInterval();
      toast(`${pomodoroLabel}結束`);
    }
  }
}

function renderPomodoro(){
  const display=document.getElementById("timerDisplay");
  if(!display) return;
  syncPomodoroRemaining();
  display.textContent=formatTimer(pomodoroRemainingSec);
  const label=document.getElementById("timerLabel");
  const status=document.getElementById("timerStatus");
  const startBtn=document.getElementById("timerStartPauseBtn");
  if(label) label.textContent=pomodoroLabel;
  if(status) status.textContent=pomodoroRunning ? "倒數中" : (pomodoroRemainingSec===0 ? "時間到" : "準備開始");
  if(startBtn) startBtn.textContent=pomodoroRunning ? "暫停" : (pomodoroRemainingSec===0 ? "重新開始" : "開始");
}

function setPomodoroDuration(minutes,labelText){
  const min=Math.max(1,Math.min(180,Number(minutes)||1));
  pomodoroDurationSec=Math.round(min*60);
  pomodoroRemainingSec=pomodoroDurationSec;
  pomodoroLabel=labelText || `自訂 ${min} 分鐘`;
  pomodoroRunning=false;
  pomodoroEndAt=null;
  stopPomodoroInterval();
  renderPomodoro();
}

function togglePomodoro(){
  syncPomodoroRemaining();
  if(pomodoroRunning){
    pomodoroRunning=false;
    pomodoroEndAt=null;
    stopPomodoroInterval();
  }else{
    if(pomodoroRemainingSec<=0) pomodoroRemainingSec=pomodoroDurationSec;
    pomodoroRunning=true;
    pomodoroEndAt=Date.now()+pomodoroRemainingSec*1000;
    stopPomodoroInterval();
    pomodoroInterval=setInterval(renderPomodoro,250);
  }
  renderPomodoro();
}

function resetPomodoro(){
  pomodoroRunning=false;
  pomodoroEndAt=null;
  pomodoroRemainingSec=pomodoroDurationSec;
  stopPomodoroInterval();
  renderPomodoro();
}

// v3.20 classroom tool: marquee
let marqueeRunning=false;
function marqueeDuration(){const speed=document.getElementById("marqueeSpeed")?.value||"normal";return speed==="slow"?16:speed==="fast"?7:11;}
function renderMarquee(){const input=document.getElementById("marqueeInput"),textEl=document.getElementById("marqueeText"),track=document.getElementById("marqueeTrack"),status=document.getElementById("marqueeStatus");if(!input||!textEl||!track)return;const text=String(input.value||"").trim();textEl.textContent=text||"請輸入跑馬燈文字";track.style.setProperty("--marquee-duration",`${marqueeDuration()}s`);track.classList.toggle("running",marqueeRunning&&!!text);if(status)status.textContent=marqueeRunning&&text?"播放中":"準備顯示";}
function startMarquee(){if(!String(document.getElementById("marqueeInput")?.value||"").trim()){toast("請先輸入跑馬燈文字");return;}marqueeRunning=true;renderMarquee();}
function stopMarquee(){marqueeRunning=false;renderMarquee();}


// v3.33 classroom tool: microphone noise monitor + quiet challenge
let noiseMode="normal", noiseStream=null, noiseAudioContext=null, noiseAnalyser=null, noiseFrame=0;
let noiseActive=false, noiseOverSince=0, noiseLastAlert=0, noiseLevel=0;
let challengeElapsedMs=0, challengeLastTick=0, challengeComplete=false;
function noiseEl(id){return document.getElementById(id)}
let noiseBalls=[], noiseBallCtx=null, noiseBallW=0, noiseBallH=0, noiseBallEnergy=0;
let noiseFloor=.006,noiseSmoothedRms=0,noiseIndicator=0,noiseCalibrating=false,noiseCalibrationUntil=0,noiseCalibrationSamples=[];
let noiseStandard="normal";
const NOISE_STANDARDS={quiet:55,normal:70,group:85};
function initNoiseBallPool(){
  const canvas=noiseEl("noiseBallCanvas"); if(!canvas)return;
  const rect=canvas.getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2);
  const w=Math.max(280,Math.round(rect.width||620)),h=Math.max(180,Math.round(rect.height||260));
  const sizeChanged=canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr);
  if(sizeChanged){
    canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);canvas.style.width=w+"px";canvas.style.height=h+"px";
    noiseBallCtx=canvas.getContext("2d");noiseBallCtx.setTransform(dpr,0,0,dpr,0,0);noiseBallW=w;noiseBallH=h;
  }
  const desired=w<430?30:48;
  if(!noiseBalls.length || noiseBalls.length!==desired){
    noiseBalls=[];
    for(let i=0;i<desired;i++){
      const r=8+Math.random()*12;
      noiseBalls.push({
        x:r+Math.random()*(w-r*2),
        y:Math.max(r,h-r-Math.random()*Math.min(h*.48,150)),
        vx:(Math.random()-.5)*.55,vy:Math.random()*.15,
        r,phase:Math.random()*Math.PI*2,hue:195+Math.random()*45
      });
    }
  }else if(sizeChanged){
    for(const b of noiseBalls){b.x=Math.max(b.r,Math.min(w-b.r,b.x));b.y=Math.max(b.r,Math.min(h-b.r,b.y))}
  }
}
function drawNoiseBallPool(now,level,warning){
  initNoiseBallPool();const ctx=noiseBallCtx;if(!ctx)return;
  // 聲音轉為「向上彈力」；安靜時則由重力把球帶回池底。
  const normalized=level/100;
  const threshold=Math.max(5,noiseSettings().threshold);
  const proximity=Math.max(0,Math.min(1,level/threshold));
  // 越接近警戒閾值，額外擾動會非線性升高；達到警戒值時最明顯。
  const proximityBoost=Math.pow(proximity,2.25);
  const target=Math.pow(normalized,1.12)*1.05 + proximityBoost*1.35;
  noiseBallEnergy+=(target-noiseBallEnergy)*(target>noiseBallEnergy?.16:.055);
  ctx.clearRect(0,0,noiseBallW,noiseBallH);
  const gravity=.075, lift=noiseBallEnergy*(.085+proximityBoost*.055);
  for(const b of noiseBalls){
    // 每顆球的相位略不同，避免整池同步上下移動。
    const pulse=.55+.45*Math.sin(now/155+b.phase);
    b.vy+=gravity-lift*(.55+pulse*.75);
    b.vx+=Math.sin(now/210+b.phase)*noiseBallEnergy*(.010+proximityBoost*.024);
    const maxX=.65+noiseBallEnergy*(2.0+proximityBoost*2.1),maxY=1.7+noiseBallEnergy*(4.8+proximityBoost*3.8);
    b.vx=Math.max(-maxX,Math.min(maxX,b.vx));
    b.vy=Math.max(-maxY,Math.min(maxY,b.vy));
    b.vx*=.996;b.vy*=.999;
    b.x+=b.vx;b.y+=b.vy;
    if(b.x<b.r){b.x=b.r;b.vx=Math.abs(b.vx)*.84}
    if(b.x>noiseBallW-b.r){b.x=noiseBallW-b.r;b.vx=-Math.abs(b.vx)*.84}
    if(b.y<b.r){b.y=b.r;b.vy=Math.abs(b.vy)*.78}
    if(b.y>noiseBallH-b.r){b.y=noiseBallH-b.r;b.vy=-Math.abs(b.vy)*(.45+noiseBallEnergy*.12)}
  }
  // 簡化彈性碰撞，讓安靜時能堆疊、吵雜時彼此彈開。
  for(let a=0;a<noiseBalls.length;a++)for(let b=a+1;b<noiseBalls.length;b++){
    const A=noiseBalls[a],B=noiseBalls[b],dx=B.x-A.x,dy=B.y-A.y,dist=Math.hypot(dx,dy)||.01,min=A.r+B.r;
    if(dist<min){
      const nx=dx/dist,ny=dy/dist,push=(min-dist)/2;
      A.x-=nx*push;A.y-=ny*push;B.x+=nx*push;B.y+=ny*push;
      const rel=(B.vx-A.vx)*nx+(B.vy-A.vy)*ny;
      if(rel<0){const bounce=.72;A.vx+=rel*nx*bounce;A.vy+=rel*ny*bounce;B.vx-=rel*nx*bounce;B.vy-=rel*ny*bounce}
    }
  }
  for(const b of noiseBalls){
    const grad=ctx.createRadialGradient(b.x-b.r*.32,b.y-b.r*.38,b.r*.12,b.x,b.y,b.r);
    grad.addColorStop(0,warning?"rgba(255,218,198,.98)":`hsla(${b.hue},95%,76%,.98)`);
    grad.addColorStop(.45,warning?"rgba(242,103,75,.96)":`hsla(${b.hue},88%,58%,.96)`);
    grad.addColorStop(1,warning?"rgba(196,48,42,.98)":`hsla(${b.hue},90%,42%,.98)`);
    ctx.beginPath();ctx.arc(b.x,b.y,b.r,0,Math.PI*2);ctx.fillStyle=grad;ctx.fill();
    ctx.beginPath();ctx.arc(b.x-b.r*.3,b.y-b.r*.34,b.r*.2,0,Math.PI*2);ctx.fillStyle="rgba(255,255,255,.52)";ctx.fill()
  }
  const pool=noiseEl("noiseBallPool");pool?.classList.toggle("warning",warning);
  if(pool)pool.style.transform=warning?`translate(${Math.sin(now/28)*3}px,${Math.cos(now/34)*3}px)`:"";
}

function noiseSettings(){return {sensitivity:Number(noiseEl("noiseSensitivity")?.value||100),threshold:Number(noiseEl("noiseThreshold")?.value||70),hold:Number(noiseEl("noiseHold")?.value||2)*1000,cooldown:Number(noiseEl("noiseCooldown")?.value||10)*1000,alertMode:noiseEl("noiseAlertMode")?.value||"both",target:Number(noiseEl("challengeTarget")?.value||300)*1000}}
function renderNoiseTool(){
  if(currentPage!=="scores" || currentScoreMode!=="noise") return;
  noiseEl("challengeBox")?.classList.toggle("hidden",noiseMode!=="challenge"); noiseEl("challengeTargetSetting")?.classList.toggle("hidden",noiseMode!=="challenge");
  document.querySelectorAll(".noise-mode-btn").forEach(b=>b.classList.toggle("active",b.dataset.noiseMode===noiseMode));
  const s=noiseSettings();
  if(noiseEl("sensitivityValue")) noiseEl("sensitivityValue").textContent=`${s.sensitivity}%`;
  document.querySelectorAll("[data-noise-standard]").forEach(b=>b.classList.toggle("active",b.dataset.noiseStandard===noiseStandard));
  if(noiseEl("thresholdValue"))noiseEl("thresholdValue").textContent=s.threshold; if(noiseEl("noiseThresholdMark"))noiseEl("noiseThresholdMark").style.left=`${s.threshold}%`;
  if(noiseEl("challengeTargetLabel"))noiseEl("challengeTargetLabel").textContent=formatNoiseTime(s.target); renderChallengeTime(); requestAnimationFrame(t=>drawNoiseBallPool(t,noiseActive?noiseLevel:0,false));
}
function formatNoiseTime(ms){const sec=Math.floor(ms/1000),m=Math.floor(sec/60),s=sec%60;return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`}
function renderChallengeTime(){if(noiseEl("challengeElapsed"))noiseEl("challengeElapsed").textContent=formatNoiseTime(challengeElapsedMs)}
function setNoiseMode(mode){noiseMode=mode; resetChallenge(); renderNoiseTool()}
function resetChallenge(){challengeElapsedMs=0;challengeLastTick=performance.now();challengeComplete=false;renderChallengeTime();if(noiseEl("challengeState"))noiseEl("challengeState").textContent=noiseActive?"挑戰進行中":"等待開始偵測"}
function setNoiseStandard(mode){
  noiseStandard=mode;
  if(mode!=="custom"&&NOISE_STANDARDS[mode]){
    const slider=noiseEl("noiseThreshold");if(slider)slider.value=NOISE_STANDARDS[mode];
  }
  renderNoiseTool();
}
function startNoiseCalibration(){
  if(!noiseActive){toast("請先開始音量偵測，再進行環境校正");return}
  noiseCalibrating=true;noiseCalibrationSamples=[];noiseCalibrationUntil=performance.now()+3000;
  if(noiseEl("calibrationStatus"))noiseEl("calibrationStatus").textContent="校正中…請保持環境安靜";
}
async function startNoiseMonitor(){
  if(noiseActive)return;
  if(!navigator.mediaDevices?.getUserMedia){toast("此瀏覽器不支援麥克風音量偵測");return}
  try{
    noiseStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
    noiseAudioContext=new (window.AudioContext||window.webkitAudioContext)(); await noiseAudioContext.resume();
    const source=noiseAudioContext.createMediaStreamSource(noiseStream); noiseAnalyser=noiseAudioContext.createAnalyser(); noiseAnalyser.fftSize=1024; noiseAnalyser.smoothingTimeConstant=.72; source.connect(noiseAnalyser);
    noiseActive=true;noiseOverSince=0;challengeLastTick=performance.now();noiseLastVisualFrame=0;
    noiseSmoothedRms=0;noiseIndicator=0;noiseCalibrating=true;noiseCalibrationSamples=[];noiseCalibrationUntil=performance.now()+3000;
    if(noiseEl("calibrationStatus"))noiseEl("calibrationStatus").textContent="校正中…請保持環境安靜";noiseEl("noiseStartBtn").disabled=true;noiseEl("noiseStopBtn").disabled=false;if(noiseEl("noiseStatus"))noiseEl("noiseStatus").textContent="偵測中";noiseLoop();
  }catch(err){console.warn("Microphone unavailable",err);toast("無法使用麥克風，請確認瀏覽器權限");if(noiseEl("noiseStatus"))noiseEl("noiseStatus").textContent="麥克風未授權"}
}
function stopNoiseMonitor(){
  const hadRuntime=!!(noiseActive||noiseFrame||noiseStream||noiseAudioContext);
  if(noiseFrame)cancelAnimationFrame(noiseFrame);
  noiseFrame=0;noiseLastVisualFrame=0;noiseActive=false;
  noiseStream?.getTracks().forEach(t=>t.stop());noiseStream=null;
  if(noiseAudioContext&&noiseAudioContext.state!=="closed")noiseAudioContext.close().catch(()=>{});
  noiseAudioContext=null;noiseAnalyser=null;
  noiseLevel=0;noiseIndicator=0;noiseSmoothedRms=0;noiseCalibrating=false;noiseBallEnergy=0;
  const start=noiseEl("noiseStartBtn"),stop=noiseEl("noiseStopBtn");
  if(start)start.disabled=false;if(stop)stop.disabled=true;
  if(noiseEl("noiseStatus"))noiseEl("noiseStatus").textContent="已停止";
  if(noiseEl("noiseMessage"))noiseEl("noiseMessage").textContent="偵測已停止";
  if(noiseEl("noiseMeterFill"))noiseEl("noiseMeterFill").style.width="0%";
  if(noiseEl("noiseLevelText"))noiseEl("noiseLevelText").textContent="0";
  if(noiseEl("noiseStateBadge")){noiseEl("noiseStateBadge").textContent="等待偵測";noiseEl("noiseStateBadge").className="noise-state-badge"}
  // 只有音量工具仍在畫面上時才補畫靜止球池；離頁時不再做額外 canvas 工作。
  if(hadRuntime&&currentPage==="scores"&&currentScoreMode==="noise"&&noiseEl("noiseCanvas"))drawNoiseBallPool(performance.now(),0,false);
}
let noiseLastVisualFrame=0;
function noiseLoop(now=performance.now()){
  if(!noiseActive||!noiseAnalyser)return;
  const arr=new Uint8Array(noiseAnalyser.fftSize);noiseAnalyser.getByteTimeDomainData(arr);
  let sum=0;for(const v of arr){const x=(v-128)/128;sum+=x*x}const rms=Math.sqrt(sum/arr.length);

  if(noiseCalibrating){
    noiseCalibrationSamples.push(rms);
    if(now>=noiseCalibrationUntil){
      const sorted=[...noiseCalibrationSamples].sort((a,b)=>a-b);
      // 使用中位數降低校正期間偶發聲響的影響。
      noiseFloor=Math.max(.0015,sorted[Math.floor(sorted.length*.5)]||rms||.006);
      noiseCalibrating=false;noiseSmoothedRms=noiseFloor;noiseIndicator=0;
      if(noiseEl("calibrationStatus"))noiseEl("calibrationStatus").textContent="已完成";
    }
    noiseLevel=0;
    if(now-noiseLastVisualFrame>=33){noiseLastVisualFrame=now;updateNoiseVisual(now)}
    noiseFrame=requestAnimationFrame(noiseLoop);return;
  }

  // 第一層：裝置微調；第二層：相對背景噪音；第三層：快升慢降平滑，抑制咳嗽、關門等瞬間尖峰。
  const trim=noiseSettings().sensitivity/100;
  const relative=Math.max(0,(rms-noiseFloor)*trim);
  const attack=relative>noiseSmoothedRms?.18:.045;
  noiseSmoothedRms+=(relative-noiseSmoothedRms)*attack;
  const ratio=noiseSmoothedRms/Math.max(.0025,noiseFloor);
  const targetIndicator=Math.max(0,Math.min(100,Math.pow(Math.min(1,ratio/7.5),.62)*100));
  const indicatorAttack=targetIndicator>noiseIndicator?.16:.055;
  noiseIndicator+=(targetIndicator-noiseIndicator)*indicatorAttack;
  noiseLevel=Math.round(noiseIndicator);
  if(now-noiseLastVisualFrame>=33){noiseLastVisualFrame=now;updateNoiseVisual(now)}
  noiseFrame=requestAnimationFrame(noiseLoop)
}
function updateNoiseVisual(now){
  const s=noiseSettings(),over=noiseLevel>=s.threshold,fill=noiseEl("noiseMeterFill");if(fill)fill.style.width=`${noiseLevel}%`;if(noiseEl("noiseLevelText"))noiseEl("noiseLevelText").textContent=`${noiseLevel}`;
  drawNoiseBallPool(now,noiseLevel,over);
  const ratioToLimit=noiseLevel/Math.max(1,s.threshold);
  let state="安靜",stateClass="quiet";
  if(ratioToLimit>=1){state="超過警戒",stateClass="over"}
  else if(ratioToLimit>=.85){state="接近警戒",stateClass="near"}
  else if(ratioToLimit>=.62){state="偏吵",stateClass="busy"}
  else if(ratioToLimit>=.35){state="正常",stateClass="normal"}
  if(noiseEl("noiseStateBadge")){noiseEl("noiseStateBadge").textContent=noiseCalibrating?"環境校正中":state;noiseEl("noiseStateBadge").className=`noise-state-badge ${noiseCalibrating?"calibrating":stateClass}`}
  if(noiseCalibrating){noiseOverSince=0;if(noiseEl("noiseMessage"))noiseEl("noiseMessage").textContent="請保持環境安靜，正在建立背景基準…"}
  else if(over){if(!noiseOverSince)noiseOverSince=now;const held=now-noiseOverSince>=s.hold;if(noiseEl("noiseMessage"))noiseEl("noiseMessage").textContent=held?"🔔 音量超過警戒標準":"接近警戒…";if(held&&now-noiseLastAlert>=s.cooldown){noiseLastAlert=now;triggerNoiseAlert(s.alertMode)}}
  else{noiseOverSince=0;if(noiseEl("noiseMessage"))noiseEl("noiseMessage").textContent=state}
  if(noiseMode==="challenge"&&!challengeComplete){const dt=Math.max(0,now-challengeLastTick);const paused=over&&noiseOverSince&&now-noiseOverSince>=s.hold;if(!paused)challengeElapsedMs+=dt;challengeLastTick=now;if(noiseEl("challengeState"))noiseEl("challengeState").textContent=paused?"⏸ 音量超標，計時暫停":"挑戰進行中";if(challengeElapsedMs>=s.target){challengeElapsedMs=s.target;challengeComplete=true;if(noiseEl("challengeState"))noiseEl("challengeState").textContent="🎉 挑戰成功！";noiseEl("noiseVisual")?.classList.add("challenge-success");setTimeout(()=>noiseEl("noiseVisual")?.classList.remove("challenge-success"),1800);triggerNoiseAlert("both",true)}renderChallengeTime()}else challengeLastTick=now;
}
function triggerNoiseAlert(mode,success=false){noiseEl("noiseVisual")?.classList.add(success?"success-flash":"alert-flash");setTimeout(()=>noiseEl("noiseVisual")?.classList.remove("alert-flash","success-flash"),700);if(mode==="both")playNoiseTone(success)}
function playNoiseTone(success=false){try{const ctx=noiseAudioContext;if(!ctx)return;const osc=ctx.createOscillator(),gain=ctx.createGain();osc.frequency.value=success?740:520;gain.gain.setValueAtTime(.0001,ctx.currentTime);gain.gain.exponentialRampToValueAtTime(.12,ctx.currentTime+.02);gain.gain.exponentialRampToValueAtTime(.0001,ctx.currentTime+.22);osc.connect(gain);gain.connect(ctx.destination);osc.start();osc.stop(ctx.currentTime+.24)}catch(e){}}

function studentScore(studentId){
  const value = Number(data.scores?.[studentId] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function changeStudentScore(studentId, delta){
  if(!data.scores || typeof data.scores!=="object") data.scores = {};
  data.scores[studentId] = studentScore(studentId) + delta;
  saveData();
}

function openScoreAdjust(kind,id){
  const isGroup=kind==="group",label=isGroup?(data.groups.find(g=>g.id===id)?.name||"小組"):(data.students.find(s=>s.id===id)?.name||"學生");
  let scoreAdjustMode="plus";
  showModal(`調整${isGroup?"小組":"個人"}積分`,`<form id="scoreAdjustForm" class="modal-form">
    <div class="notice-box">${escapeHtml(label)}｜先選擇加分或減分，再輸入分數。</div>
    <div class="score-adjust-mode" role="group" aria-label="積分調整方式">
      <button type="button" class="score-adjust-mode-btn active" data-score-adjust-mode="plus">＋ 加分</button>
      <button type="button" class="score-adjust-mode-btn" data-score-adjust-mode="minus">－ 減分</button>
    </div>
    <label><span>分數</span><input id="scoreAdjustValue" type="number" min="1" step="1" value="2" inputmode="numeric" required></label>
    <div class="modal-actions"><button type="button" class="secondary" onclick="closeModal()">取消</button><button class="primary">套用</button></div>
  </form>`);
  document.querySelectorAll("[data-score-adjust-mode]").forEach(btn=>btn.addEventListener("click",()=>{
    scoreAdjustMode=btn.dataset.scoreAdjustMode==="minus"?"minus":"plus";
    document.querySelectorAll("[data-score-adjust-mode]").forEach(x=>x.classList.toggle("active",x===btn));
  }));
  document.getElementById("scoreAdjustForm").addEventListener("submit",e=>{
    e.preventDefault();
    const value=Number(document.getElementById("scoreAdjustValue").value);
    if(!Number.isFinite(value)||value<=0){toast("請輸入大於 0 的分數");return}
    const delta=scoreAdjustMode==="minus"?-value:value;
    isGroup?changeGroupScore(id,delta):changeStudentScore(id,delta);
    closeModal();
  });
}
function renderScores(){
  const list = document.getElementById("scoreList");
  if(!list) return;
  const students = [...data.students].sort((a,b)=>a.number-b.number);
  if(!students.length){
    list.innerHTML = `<div class="empty">尚未建立學生名單，請先從班級首頁的「班級資料管理」加入學生。</div>`;
    return;
  }
  list.innerHTML = students.map(s=>{
    const score = studentScore(s.id);
    return `
      <div class="score-card">
        <div class="score-student">
          <div class="student-no">${String(s.number).padStart(2,"0")}</div>
          <div class="item-title">${escapeHtml(s.name)}</div>
        </div>
        <div class="score-controls">
          <button class="score-btn minus" onclick="changeStudentScore('${s.id}',-1)">−</button>
          <div class="score-value ${score<0 ? "negative" : score>0 ? "positive" : ""}">${score}</div>
          <button class="score-btn plus" onclick="changeStudentScore('${s.id}',1)">＋</button><button class="score-btn score-more" onclick="openScoreAdjust('student','${s.id}')">±</button>
        </div>
      </div>
    `;
  }).join("");
}

function groupScore(groupId){
  const value = Number(data.groupScores?.[groupId] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function changeGroupScore(groupId, delta){
  if(!data.groupScores || typeof data.groupScores!=="object") data.groupScores = {};
  data.groupScores[groupId] = groupScore(groupId) + delta;
  saveData();
}


function openTransferGroupScores(){
  normalizeGroups();
  const groups=data.groups.filter(g=>g.studentIds.length);
  if(!groups.length){
    toast("目前沒有可歸分的小組");
    return;
  }

  const rows=groups.map((g,i)=>{
    const members=g.studentIds.map(id=>data.students.find(s=>s.id===id)).filter(Boolean);
    const score=groupScore(g.id);
    return `
      <div class="transfer-group-row">
        <div>
          <strong>${escapeHtml(g.name || `第 ${i+1} 組`)}</strong>
          <div class="item-sub">${members.length} 人</div>
        </div>
        <div class="transfer-score ${score<0 ? "negative" : score>0 ? "positive" : ""}">${score>0?"+":""}${score}</div>
      </div>`;
  }).join("");

  showModal("小組積分歸分",`
    <div class="modal-form">
      <div class="notice-box">
        按下「確認歸分」後，每位學生會依目前所屬小組取得該組的全部積分。<br>
        例如第 1 組目前為 +3 分，該組每位學生的個人積分都會增加 3 分；負分也會一併計入。
      </div>
      <div class="transfer-group-list">${rows}</div>
      <label class="transfer-reset-option">
        <input id="resetGroupsAfterTransfer" type="checkbox" checked>
        <span>歸分完成後，將所有小組積分歸零</span>
      </label>
      <div class="modal-actions">
        <button type="button" class="secondary" onclick="closeModal()">取消</button>
        <button type="button" class="primary" onclick="confirmTransferGroupScores()">確認歸分</button>
      </div>
    </div>
  `);
}

function confirmTransferGroupScores(){
  normalizeGroups();
  if(!data.scores || typeof data.scores!=="object") data.scores={};

  let affected=0;
  data.groups.forEach(g=>{
    const score=groupScore(g.id);
    if(score===0) return;
    g.studentIds.forEach(studentId=>{
      if(!data.students.some(s=>s.id===studentId)) return;
      data.scores[studentId]=studentScore(studentId)+score;
      affected++;
    });
  });

  if(!affected){
    toast("目前沒有可歸分的小組積分");
    return;
  }

  const shouldReset=document.getElementById("resetGroupsAfterTransfer")?.checked ?? true;
  if(shouldReset){
    if(!data.groupScores || typeof data.groupScores!=="object") data.groupScores={};
    data.groups.forEach(g=>{ data.groupScores[g.id]=0; });
  }

  saveData();
  closeModal();
  toast(`已將小組積分歸分給 ${affected} 位學生`);
}

function normalizeGroups(){
  if(!Array.isArray(data.groups)) data.groups=[];
  const studentIds = new Set(data.students.map(s=>s.id));
  data.groups = data.groups.map((g,i)=>({
    id:g.id || uid("g"),
    name:g.name || `第 ${i+1} 組`,
    studentIds:Array.isArray(g.studentIds) ? g.studentIds.filter(id=>studentIds.has(id)) : []
  }));
}

function renderGroupScores(){
  const list = document.getElementById("groupScoreList");
  if(!list) return;
  normalizeGroups();

  if(!data.groups.length){
    list.innerHTML = `<div class="empty">尚未建立小組。可使用「手動分組」或「隨機分組」開始。</div>`;
    return;
  }

  list.innerHTML = data.groups.map((g,index)=>{
    const score=groupScore(g.id);
    const members=g.studentIds
      .map(id=>data.students.find(s=>s.id===id))
      .filter(Boolean)
      .sort((a,b)=>a.number-b.number);

    return `
      <div class="group-score-card">
        <div class="group-card-head">
          <div>
            <div class="group-name">${escapeHtml(g.name || `第 ${index+1} 組`)}</div>
            <div class="item-sub">${members.length} 人</div>
          </div>
          <div class="group-card-actions">
            <button class="secondary small-btn" onclick="editGroup('${g.id}')">編輯</button>
            <button class="ghost-danger small-btn" onclick="deleteGroup('${g.id}')">刪除</button>
          </div>
        </div>

        <div class="group-members">
          ${members.length ? members.map(s=>`<span class="group-member-chip">${String(s.number).padStart(2,"0")} ${escapeHtml(s.name)}</span>`).join("") : `<span class="muted">尚無成員</span>`}
        </div>

        <div class="score-controls group-score-controls">
          <button class="score-btn minus" onclick="changeGroupScore('${g.id}',-1)">−</button>
          <div class="score-value ${score<0 ? "negative" : score>0 ? "positive" : ""}">${score}</div>
          <button class="score-btn plus" onclick="changeGroupScore('${g.id}',1)">＋</button><button class="score-btn score-more" onclick="openScoreAdjust('group','${g.id}')">±</button>
        </div>
      </div>
    `;
  }).join("");
}

function openManualGrouping(){
  if(!data.students.length){
    toast("請先建立學生名單");
    return;
  }
  normalizeGroups();
  if(!data.groups.length){
    data.groups=[{id:uid("g"),name:"第 1 組",studentIds:[]}];
  }

  const groupOptions = data.groups.map((g,i)=>`<option value="${g.id}">${escapeHtml(g.name || `第 ${i+1} 組`)}</option>`).join("");
  const rows=[...data.students].sort((a,b)=>a.number-b.number).map(s=>{
    const current=data.groups.find(g=>g.studentIds.includes(s.id))?.id || "";
    return `
      <div class="manual-group-row">
        <div class="manual-student">${String(s.number).padStart(2,"0")} ${escapeHtml(s.name)}</div>
        <select data-manual-student="${s.id}">
          <option value="">未分組</option>
          ${groupOptions.replace(`value="${current}"`,`value="${current}" selected`)}
        </select>
      </div>`;
  }).join("");

  showModal("手動分組",`
    <div class="modal-form">
      <div class="manual-group-top">
        <label><span>小組數量</span><input id="manualGroupCount" type="number" min="1" max="20" value="${data.groups.length}"></label>
        <button type="button" class="secondary" onclick="rebuildManualGroupSelectors()">套用組數</button>
      </div>
      <div id="manualGroupRows" class="manual-group-list">${rows}</div>
      <div class="modal-actions">
        <button type="button" class="secondary" onclick="closeModal()">取消</button>
        <button type="button" class="primary" onclick="saveManualGrouping()">儲存分組</button>
      </div>
    </div>
  `);
}

function rebuildManualGroupSelectors(){
  const count=Math.max(1,Math.min(20,Number(document.getElementById("manualGroupCount")?.value)||1));
  const oldGroups=[...data.groups];
  const next=[];
  for(let i=0;i<count;i++){
    next.push(oldGroups[i] || {id:uid("g"),name:`第 ${i+1} 組`,studentIds:[]});
  }
  data.groups=next;
  openManualGrouping();
}

function saveManualGrouping(){
  normalizeGroups();
  data.groups.forEach(g=>g.studentIds=[]);
  document.querySelectorAll("[data-manual-student]").forEach(sel=>{
    const group=data.groups.find(g=>g.id===sel.value);
    if(group) group.studentIds.push(sel.dataset.manualStudent);
  });
  persistActiveClass();
  closeModal();
  renderGroupScores();
  toast("小組分組已儲存");
}

function openRandomGrouping(){
  if(!data.students.length){
    toast("請先建立學生名單");
    return;
  }
  showModal("隨機分組",`
    <form id="randomGroupingForm" class="modal-form">
      <label>
        <span>要分成幾組？</span>
        <input id="randomGroupCount" type="number" min="1" max="${Math.max(1,data.students.length)}" value="${Math.min(4,Math.max(1,data.students.length))}" required>
      </label>
      <div class="item-sub">學生會隨機平均分配到各組；會取代目前的小組成員配置。</div>
      <div class="modal-actions">
        <button type="button" class="secondary" onclick="closeModal()">取消</button>
        <button class="primary" type="submit">開始分組</button>
      </div>
    </form>
  `);
  document.getElementById("randomGroupingForm").addEventListener("submit",e=>{
    e.preventDefault();
    const count=Math.max(1,Math.min(data.students.length,Number(document.getElementById("randomGroupCount").value)||1));
    randomizeGroups(count);
  });
}

function randomizeGroups(count){
  const shuffled=[...data.students].sort(()=>Math.random()-.5);
  const oldScores=data.groupScores || {};
  const groups=Array.from({length:count},(_,i)=>({
    id:data.groups?.[i]?.id || uid("g"),
    name:data.groups?.[i]?.name || `第 ${i+1} 組`,
    studentIds:[]
  }));
  shuffled.forEach((s,i)=>groups[i%count].studentIds.push(s.id));
  data.groups=groups;
  data.groupScores=Object.fromEntries(groups.map(g=>[g.id,Number(oldScores[g.id]||0)]));
  saveData();
  closeModal();
  setScoreMode("group");
  toast(`已隨機分成 ${count} 組`);
}

function editGroup(groupId){
  const group=data.groups.find(g=>g.id===groupId);
  if(!group) return;

  const memberIds=new Set(group.studentIds || []);
  const studentOptions=[...data.students]
    .sort((a,b)=>a.number-b.number)
    .map(s=>`
      <label class="group-edit-student">
        <input type="checkbox" value="${s.id}" ${memberIds.has(s.id) ? "checked" : ""}>
        <span>${String(s.number).padStart(2,"0")} ${escapeHtml(s.name)}</span>
      </label>
    `).join("");

  showModal("編輯小組",`
    <form id="editGroupForm" class="modal-form">
      <label>
        <span>小組名稱</span>
        <input id="editGroupName" value="${escapeAttr(group.name || "")}" required>
      </label>
      <div>
        <span class="form-label">小組成員</span>
        <div id="editGroupMembers" class="group-edit-students">${studentOptions}</div>
      </div>
      <div class="modal-actions">
        <button type="button" class="secondary" onclick="closeModal()">取消</button>
        <button class="primary" type="submit">儲存變更</button>
      </div>
    </form>
  `);

  document.getElementById("editGroupForm").addEventListener("submit",e=>{
    e.preventDefault();
    group.name=document.getElementById("editGroupName").value.trim();
    group.studentIds=[...document.querySelectorAll("#editGroupMembers input:checked")].map(el=>el.value);

    const selected=new Set(group.studentIds);
    data.groups.forEach(g=>{
      if(g.id===group.id) return;
      g.studentIds=(g.studentIds || []).filter(id=>!selected.has(id));
    });

    saveData();
    closeModal();
    setScoreMode("group");
    toast("小組資料已更新");
  });
}

function deleteGroup(groupId){
  const group=data.groups.find(g=>g.id===groupId);
  if(!group) return;
  const score=groupScore(groupId);
  const message=score!==0
    ? `確定要刪除「${group.name}」嗎？\n\n此小組目前有 ${score} 分，刪除後小組成員配置與小組積分都會移除。學生與個人積分不受影響。`
    : `確定要刪除「${group.name}」嗎？\n\n小組成員配置會移除，但學生與個人積分不受影響。`;
  if(!confirm(message)) return;

  data.groups=data.groups.filter(g=>g.id!==groupId);
  if(data.groupScores && typeof data.groupScores==="object"){
    delete data.groupScores[groupId];
  }
  saveData();
  setScoreMode("group");
  toast("小組已刪除");
}

function resetGroupScores(){
  if(!data.groups.length){
    toast("目前沒有小組");
    return;
  }
  if(!confirm("確定要將所有小組積分歸零嗎？")) return;
  data.groupScores={};
  saveData();
  toast("小組積分已歸零");
}




function addStudentTag(studentId){
  const s=data.students.find(x=>x.id===studentId),input=document.getElementById(`seatStudentTagInput-${studentId}`);if(!s||!input)return;
  const tag=input.value.trim();if(!tag)return;if(!Array.isArray(s.tags))s.tags=[];if(!s.tags.includes(tag))s.tags.push(tag);saveData();openSeatTagSettings();
}
function removeStudentTag(studentId,encoded){
  const s=data.students.find(x=>x.id===studentId);if(!s)return;const tag=decodeURIComponent(encoded);
  s.tags=(s.tags||[]).filter(t=>t!==tag);saveData();openSeatTagSettings();
}
function seatingStudentOptions(selected=[]){
  return [...data.students].sort((a,b)=>a.number-b.number).map(s=>`<label class="rule-student"><input type="checkbox" value="${s.id}" ${selected.includes(s.id)?"checked":""}> ${String(s.number).padStart(2,"0")} ${escapeHtml(s.name)}</label>`).join("");
}
function allStudentTags(){return [...new Set(data.students.flatMap(s=>s.tags||[]))].sort((a,b)=>a.localeCompare(b,"zh-Hant"))}
function openSeatSettings(){
  normalizeSeating();
  showModal("設定",`<div class="seat-backstage">
    <div><strong>教師後台</strong><p class="muted">以下設定不會出現在座位展示模式中。</p></div>
    <button type="button" class="seat-setting-entry" onclick="openSeatTagSettings()"><span><b>學生註記</b><small>建立與管理座位分配使用的學生分類</small></span><span>›</span></button>
    <button type="button" class="seat-setting-entry" onclick="openSeatRules()"><span><b>隱藏分配規則</b><small>設定學生群組、註記與座位限制</small></span><span>›</span></button>
    <div class="seat-setting-note">「隨機分配」會自動套用所有已啟用的隱藏規則。</div>
  </div>`);
}
function openSeatTagSettings(){
  const students=[...data.students].sort((a,b)=>a.number-b.number);
  showModal("學生註記",`
    <div class="seat-rule-actions"><button class="secondary" onclick="openSeatSettings()">← 返回設定</button></div>
    <p class="muted">註記僅供座位分配規則分類使用，可在建立規則時直接套用。</p>
    <div class="seat-tag-list">${students.length?students.map(s=>`
      <div class="seat-tag-card">
        <div class="seat-tag-student"><strong>${String(s.number).padStart(2,"0")} ${escapeHtml(s.name)}</strong>
          <div class="student-tags">${(s.tags||[]).map(t=>`<span>${escapeHtml(t)} <button type="button" aria-label="移除 ${escapeHtml(t)}" onclick="removeStudentTag('${s.id}','${encodeURIComponent(t)}')">×</button></span>`).join("")||"<em>尚無標籤</em>"}</div>
        </div>
        <div class="tag-add-row"><input id="seatStudentTagInput-${s.id}" placeholder="新增註記"><button type="button" class="secondary" onclick="addStudentTag('${s.id}')">新增</button></div>
      </div>`).join(""):`<div class="empty">尚未建立學生。</div>`}</div>`);
}
function seatRuleKindLabel(kind){
  return {around8:"周圍八格不相鄰",checkerboard:"梅花座",fixedSeat:"指定特定座位",front2:"指定坐前兩排",noCorner:"不能坐角落",back2:"指定坐後兩排",horizontalAdjacent:"左右相鄰"}[kind]||"規則";
}
function seatRuleTargetLabel(r){
  if(r.type==="tag")return `註記：${escapeHtml(r.tag||"")}`;
  const names=(r.studentIds||[]).map(id=>data.students.find(s=>s.id===id)?.name).filter(Boolean);
  return names.length?escapeHtml(names.join("、")):`${(r.studentIds||[]).length} 位學生`;
}
function seatRuleSeatOptions(selectedIndex=""){
  normalizeSeating();const {rows,cols,blocked}=data.seating;let html="";
  for(let i=0;i<rows*cols;i++){
    const row=Math.floor(i/cols)+1,col=i%cols+1,isBlocked=blocked[i]===true;
    html+=`<option value="${i}" ${String(i)===String(selectedIndex)?"selected":""} ${isBlocked?"disabled":""}>第 ${row} 排・第 ${col} 位${isBlocked?"（已封鎖）":""}</option>`;
  }
  return html;
}
function updateSeatRuleFormUI(){
  const type=document.getElementById("seatRuleType"),kind=document.getElementById("seatRuleKind");
  if(!type||!kind)return;
  const group=document.getElementById("seatRuleGroupBox"),tag=document.getElementById("seatRuleTagBox"),fixed=document.getElementById("seatRuleFixedBox"),hint=document.getElementById("seatRuleTargetHint");
  group.style.display=type.value==="group"?"block":"none";
  tag.style.display=type.value==="tag"?"block":"none";
  fixed.style.display=kind.value==="fixedSeat"?"block":"none";
  if(hint)hint.textContent=kind.value==="fixedSeat"?"指定特定座位需選擇 1 位學生。":kind.value==="horizontalAdjacent"?"左右相鄰至少選擇 2 位學生；多人時會安排在同一排連續座位。":kind.value==="checkerboard"?"梅花座中的學生彼此前後左右不可相鄰，但斜角可以相鄰。":"可選擇 1 位以上學生，或改用學生註記。";
  if(kind.value==="fixedSeat"&&type.value==="tag"){type.value="group";group.style.display="block";tag.style.display="none"}
}
function seatRuleKindOptions(selected=""){
  return [
    ["around8","周圍八格不相鄰"],
    ["checkerboard","梅花座"],
    ["fixedSeat","指定特定座位"],
    ["front2","指定坐前兩排"],
    ["noCorner","不能坐角落"],
    ["back2","指定坐後兩排"],
    ["horizontalAdjacent","左右相鄰"]
  ].map(([v,t])=>`<option value="${v}" ${selected===v?"selected":""}>${t}</option>`).join("");
}
function openSeatRules(){
  normalizeSeating();
  // v2.0.7：舊版「左右不相鄰／前後左右不相鄰」正式退場，不再參與分配。
  data.seating.rules=data.seating.rules.filter(r=>!["horizontal","orthogonal","front"].includes(r.kind));
  const rules=data.seating.rules;
  showModal("隱藏分配規則",`
    <p class="muted">規則只供教師分配座位使用，不會出現在展示模式或學生視角。</p>
    <div class="seat-rule-actions"><button class="secondary" onclick="openSeatSettings()">← 返回設定</button><button class="secondary" onclick="openNewSeatRule()">＋新增規則</button></div>
    <div class="seat-rule-list">${rules.length?rules.map(r=>`<div class="seat-rule-card"><div><strong>${escapeHtml(r.name||"未命名規則")}</strong><div class="item-sub">${seatRuleTargetLabel(r)}｜${seatRuleKindLabel(r.kind)}${r.kind==="fixedSeat"&&Number.isInteger(Number(r.seatIndex))?`（${Math.floor(Number(r.seatIndex)/data.seating.cols)+1}排${Number(r.seatIndex)%data.seating.cols+1}位）`:""}</div></div><label class="rule-toggle"><input type="checkbox" ${r.enabled!==false?"checked":""} onchange="toggleSeatRule('${r.id}',this.checked)">啟用</label><button class="secondary" onclick="editSeatRule('${r.id}')">編輯</button><button class="secondary" onclick="deleteSeatRule('${r.id}')">刪除</button></div>`).join(""):`<div class="empty">尚未建立分配規則。</div>`}</div>`);
}
function seatRuleFormMarkup(r=null){
  const tags=allStudentTags(),type=r?.type||"group";
  return `<form id="${r?"seatRuleEditForm":"seatRuleForm"}" class="modal-form">
    <label><span>規則名稱</span><input id="seatRuleName" value="${escapeHtml(r?.name||"")}" placeholder="例如：小明坐前兩排" required></label>
    <label><span>規則</span><select id="seatRuleKind">${seatRuleKindOptions(r?.kind||"around8")}</select></label>
    <label><span>套用方式</span><select id="seatRuleType"><option value="group" ${type==="group"?"selected":""}>指定學生</option><option value="tag" ${type==="tag"?"selected":""}>依學生註記</option></select></label>
    <div id="seatRuleGroupBox" style="${type==="tag"?"display:none":""}"><span class="setting-title">選擇學生</span><div id="seatRuleTargetHint" class="item-sub"></div><div class="rule-student-grid">${seatingStudentOptions(r?.studentIds||[])}</div></div>
    <label id="seatRuleTagBox" style="${type==="tag"?"":"display:none"}"><span>學生註記</span><select id="seatRuleTag">${tags.map(t=>`<option ${t===r?.tag?"selected":""}>${escapeHtml(t)}</option>`).join("")}</select></label>
    <label id="seatRuleFixedBox" style="${r?.kind==="fixedSeat"?"":"display:none"}"><span>指定座位</span><select id="seatRuleFixedSeat">${seatRuleSeatOptions(r?.seatIndex??"")}</select></label>
    <div class="modal-actions"><button type="button" class="secondary" onclick="openSeatRules()">取消</button><button class="primary">${r?"儲存修改":"建立規則"}</button></div>
  </form>`;
}
function readSeatRuleForm(){
  const type=document.getElementById("seatRuleType").value,kind=document.getElementById("seatRuleKind").value;
  const ids=[...document.querySelectorAll("#seatRuleGroupBox input:checked")].map(x=>x.value);
  const tag=document.getElementById("seatRuleTag")?.value||"";
  const seatIndex=kind==="fixedSeat"?Number(document.getElementById("seatRuleFixedSeat").value):null;
  if(type==="group"){
    const min=kind==="horizontalAdjacent"?2:1,max=kind==="fixedSeat"?1:Infinity;
    if(ids.length<min){toast(kind==="horizontalAdjacent"?"左右相鄰至少選擇 2 位學生":"請至少選擇 1 位學生");return null}
    if(ids.length>max){toast("指定特定座位一次只能選擇 1 位學生");return null}
  }
  if(type==="tag"&&!tag){toast("請先替學生建立註記");return null}
  if(kind==="fixedSeat"&&type!=="group"){toast("指定特定座位請直接選擇 1 位學生");return null}
  if(kind==="fixedSeat"&&data.seating.blocked[seatIndex]){toast("指定的座位目前已封鎖");return null}
  return {name:document.getElementById("seatRuleName").value.trim(),type,studentIds:ids,tag,kind,seatIndex};
}
function bindSeatRuleForm(formId,onSubmit){
  const type=document.getElementById("seatRuleType"),kind=document.getElementById("seatRuleKind");
  type.addEventListener("change",updateSeatRuleFormUI);kind.addEventListener("change",updateSeatRuleFormUI);updateSeatRuleFormUI();
  document.getElementById(formId).addEventListener("submit",e=>{e.preventDefault();const v=readSeatRuleForm();if(v)onSubmit(v)});
}
function openNewSeatRule(){
  showModal("新增分配規則",seatRuleFormMarkup());
  bindSeatRuleForm("seatRuleForm",v=>{data.seating.rules.push({id:uid("sr"),...v,enabled:true});saveData();openSeatRules()});
}
function editSeatRule(id){
  const r=data.seating.rules.find(x=>x.id===id);if(!r)return;
  showModal("編輯分配規則",seatRuleFormMarkup(r));
  bindSeatRuleForm("seatRuleEditForm",v=>{Object.assign(r,v);saveData();openSeatRules()});
}
function toggleSeatRule(id,enabled){const r=data.seating.rules.find(x=>x.id===id);if(r){r.enabled=enabled;saveData();openSeatRules()}}
function deleteSeatRule(id){if(!confirm("確定刪除這條分配規則嗎？"))return;data.seating.rules=data.seating.rules.filter(x=>x.id!==id);saveData();openSeatRules()}
function seatCoords(i,cols){return {r:Math.floor(i/cols),c:i%cols}}
function seatRuleIds(rule){
  return rule.type==="tag"?data.students.filter(s=>(s.tags||[]).includes(rule.tag)).map(s=>s.id):(rule.studentIds||[]);
}
function violatesSeatRules(slots){
  const cols=data.seating.cols,rows=data.seating.rows,position={};slots.forEach((id,i)=>{if(id)position[id]=i});
  for(const rule of data.seating.rules.filter(r=>r.enabled!==false)){
    const ids=seatRuleIds(rule).filter(id=>position[id]!=null);
    if(rule.kind==="around8"){
      for(let a=0;a<ids.length;a++)for(let b=a+1;b<ids.length;b++){const A=seatCoords(position[ids[a]],cols),B=seatCoords(position[ids[b]],cols);if(Math.max(Math.abs(A.r-B.r),Math.abs(A.c-B.c))===1)return true}
    }else if(rule.kind==="checkerboard"){
      for(let a=0;a<ids.length;a++)for(let b=a+1;b<ids.length;b++){const A=seatCoords(position[ids[a]],cols),B=seatCoords(position[ids[b]],cols);if(Math.abs(A.r-B.r)+Math.abs(A.c-B.c)===1)return true}
    }else if(rule.kind==="fixedSeat"){
      if(ids.length&&position[ids[0]]!==Number(rule.seatIndex))return true;
    }else if(rule.kind==="front2"){
      if(ids.some(id=>seatCoords(position[id],cols).r>Math.min(1,rows-1)))return true;
    }else if(rule.kind==="back2"){
      if(ids.some(id=>seatCoords(position[id],cols).r<Math.max(0,rows-2)))return true;
    }else if(rule.kind==="noCorner"){
      const corners=new Set([0,cols-1,(rows-1)*cols,rows*cols-1]);
      if(ids.some(id=>corners.has(position[id])))return true;
    }else if(rule.kind==="horizontalAdjacent"){
      if(ids.length>=2){
        const coords=ids.map(id=>seatCoords(position[id],cols)).sort((a,b)=>a.c-b.c);
        if(coords.some(x=>x.r!==coords[0].r))return true;
        for(let i=1;i<coords.length;i++)if(coords[i].c!==coords[i-1].c+1)return true;
      }
    }
  }
  return false;
}
function seatSoftScore(){return 0}

function createSeatHistorySnapshot(label="手動儲存"){
  normalizeSeating();if(!data.seating.slots.some(Boolean))return false;
  data.seating.history.unshift({id:uid("sh"),at:new Date().toISOString(),label,rows:data.seating.rows,cols:data.seating.cols,slots:[...data.seating.slots],blocked:[...data.seating.blocked],view:data.seating.view});
  data.seating.history=data.seating.history.slice(0,20);return true;
}
function saveSeatHistory(label="手動儲存"){
  if(!createSeatHistorySnapshot(label)){toast("目前沒有座位可以儲存");return}
  saveData();toast("已儲存座位快照");
}
function openSeatHistory(){
  normalizeSeating();showModal("座位歷史",`<p class="muted">每班保留最近 20 份座位紀錄。</p><div class="seat-history-list">${data.seating.history.length?data.seating.history.map(x=>`<div class="seat-history-card"><div><strong>${escapeHtml(x.label)}</strong><div class="item-sub">${new Date(x.at).toLocaleString("zh-TW")}｜${x.rows} × ${x.cols}｜${x.view==="student"?"學生視角":x.view==="teacher"?"教師視角":"舊版紀錄"}</div></div><button class="secondary" onclick="previewSeatHistory('${x.id}')">查看</button><button class="secondary" onclick="restoreSeatHistory('${x.id}')">恢復</button><button class="secondary" onclick="deleteSeatHistory('${x.id}')">刪除</button></div>`).join(""):`<div class="empty">目前沒有座位歷史。</div>`}</div>`);
}

function seatSnapshotHtml(x){
  const snapshotView=x.view==="student"?"student":x.view==="teacher"?"teacher":data.seating.view;
  const order=[...Array(x.rows*x.cols).keys()];
  if(snapshotView==="teacher")order.reverse();
  const grid=`<div class="seat-grid preview-grid" style="grid-template-columns:repeat(${x.cols},minmax(0,1fr))">${order.map(i=>{const s=data.students.find(v=>v.id===x.slots[i]),blocked=Array.isArray(x.blocked)&&x.blocked[i];return `<div class="seat-slot ${blocked?"blocked":s?"occupied":"empty"}">${blocked?`<span class="seat-blocked-label">已封鎖</span>`:s?`<div class="seat-number">${String(s.number).padStart(2,"0")}</div><strong>${escapeHtml(s.name)}</strong>`:"<span>空位</span>"}</div>`}).join("")}</div>`;
  const front=`<div class="seat-front">黑板／講臺</div>`;
  return `<div class="seat-history-preview ${snapshotView==="teacher"?"student-view":""}">${snapshotView==="teacher"?grid+front:front+grid}</div>`;
}
function previewSeatHistory(id){
  const x=data.seating.history.find(v=>v.id===id);if(!x)return;
  showModal("查看座位歷史",`<div class="history-preview-meta"><strong>${escapeHtml(x.label)}</strong><span>${new Date(x.at).toLocaleString("zh-TW")}｜${x.rows} × ${x.cols}｜${x.view==="student"?"學生視角":x.view==="teacher"?"教師視角":"舊版紀錄"}</span></div>${seatSnapshotHtml(x)}<div class="modal-actions"><button class="secondary" onclick="openSeatHistory()">返回歷史</button><button class="primary" onclick="restoreSeatHistory('${x.id}')">恢復此版本</button></div>`);
}
function restoreSeatHistory(id){
  const x=data.seating.history.find(v=>v.id===id);if(!x||!confirm("確定恢復這份座位配置嗎？目前座位會先自動備份。"))return;
  const snapshot={rows:x.rows,cols:x.cols,slots:[...x.slots],blocked:Array.isArray(x.blocked)?[...x.blocked]:Array(x.rows*x.cols).fill(false),view:x.view==="student"?"student":x.view==="teacher"?"teacher":data.seating.view};
  createSeatHistorySnapshot("恢復前自動備份");
  data.seating.rows=snapshot.rows;data.seating.cols=snapshot.cols;data.seating.slots=snapshot.slots;data.seating.blocked=snapshot.blocked;data.seating.view=snapshot.view;
  saveData();closeModal();toast("已恢復座位配置");
}
function deleteSeatHistory(id){if(!confirm("確定刪除這份座位歷史嗎？"))return;data.seating.history=data.seating.history.filter(x=>x.id!==id);saveData();openSeatHistory()}
function normalizeSeating(){
  if(!data.seating||typeof data.seating!=="object")data.seating={rows:5,cols:3,slots:[],blocked:[],view:"teacher",rules:[],history:[]};
  data.seating.rows=Math.max(1,Math.min(10,Number(data.seating.rows)||5));
  data.seating.cols=Math.max(1,Math.min(10,Number(data.seating.cols)||3));
  const count=data.seating.rows*data.seating.cols;
  const valid=new Set(data.students.map(s=>s.id)),used=new Set();
  const old=Array.isArray(data.seating.slots)?data.seating.slots:[];
  data.seating.slots=Array.from({length:count},(_,i)=>{
    const id=old[i];
    if(id&&valid.has(id)&&!used.has(id)){used.add(id);return id}
    return null;
  });
  const oldBlocked=Array.isArray(data.seating.blocked)?data.seating.blocked:[];
  data.seating.blocked=Array.from({length:count},(_,i)=>oldBlocked[i]===true);
  data.seating.view=data.seating.view==="student"?"student":"teacher";
  if(!Array.isArray(data.seating.rules))data.seating.rules=[];
  if(!Array.isArray(data.seating.history))data.seating.history=[];
}

function unmountSeatModule(){
  const grid=document.getElementById("seatGrid");
  if(grid){grid.replaceChildren();grid.style.gridTemplateColumns="";}
  const room=document.getElementById("seatRoom");
  const cardPanel=document.getElementById("seatCardPanel");if(cardPanel)cardPanel.replaceChildren();
  seatCardRevealed=new Set();
  if(room){
    room.classList.remove("presentation","step-reveal","card-reveal","front-step-reveal","front-card-reveal","student-view");
    const front=room.querySelector(".seat-front"),wrap=room.querySelector(".seat-presentation-stage");
    if(front&&wrap)room.append(front,wrap);
  }
}

function renderSeats(){
  const grid=document.getElementById("seatGrid");if(!grid)return;
  normalizeSeating();
  const s=data.seating, order=[...Array(s.slots.length).keys()];
  if(s.view==="teacher")order.reverse();
  grid.style.gridTemplateColumns=`repeat(${s.cols},minmax(0,1fr))`;
  grid.innerHTML=order.map(index=>{
    const student=data.students.find(x=>x.id===s.slots[index]),blocked=s.blocked[index]===true;
    return `<div class="seat-slot ${blocked?"blocked":student?"occupied":"empty"}" data-seat-index="${index}" ${student?`data-student-id="${student.id}"`:""} draggable="${!blocked&&student?"true":"false"}">
      ${blocked?`<span class="seat-blocked-label">已封鎖</span>`:student?`<div class="seat-number">${String(student.number).padStart(2,"0")}</div><strong>${escapeHtml(student.name)}</strong><div class="seat-reveal-cover"><span>點擊揭曉</span></div>`:`<span>空位</span>`}
    </div>`;
  }).join("");
  const rows=document.getElementById("seatRows"),cols=document.getElementById("seatCols");
  if(rows)rows.value=s.rows;if(cols)cols.value=s.cols;
  const room=document.getElementById("seatRoom");
  if(room){
    room.classList.toggle("student-view",s.view==="teacher");
    const front=room.querySelector(".seat-front"),wrap=room.querySelector(".seat-presentation-stage");
    if(front&&wrap){
      if(s.view==="teacher"){room.append(wrap,front)}
      else{room.append(front,wrap)}
    }
  }
  const vb=document.getElementById("seatViewBtn");if(vb)vb.textContent=s.view==="teacher"?"切換學生視角":"切換教師視角";
  grid.querySelectorAll(".seat-slot").forEach(el=>{
    el.addEventListener("click",()=>{const room=document.getElementById("seatRoom");if(room?.classList.contains("presentation"))return;toggleSeatBlocked(Number(el.dataset.seatIndex))});
    el.addEventListener("dragstart",e=>{if(!el.classList.contains("occupied"))return;e.dataTransfer.setData("text/plain",el.dataset.seatIndex);el.classList.add("dragging")});
    el.addEventListener("dragend",()=>el.classList.remove("dragging"));
    el.addEventListener("dragover",e=>{if(el.classList.contains("blocked"))return;e.preventDefault();el.classList.add("drag-over")});
    el.addEventListener("dragleave",()=>el.classList.remove("drag-over"));
    el.addEventListener("drop",e=>{if(el.classList.contains("blocked"))return;e.preventDefault();el.classList.remove("drag-over");const from=Number(e.dataTransfer.getData("text/plain")),to=Number(el.dataset.seatIndex);moveSeat(from,to)});
  });
}
function toggleSeatBlocked(index){
  normalizeSeating();if(!Number.isInteger(index)||index<0||index>=data.seating.slots.length)return;
  const blocking=!data.seating.blocked[index];
  if(blocking&&data.seating.slots[index]){
    if(!confirm("這個座位目前有學生。封鎖後會將學生移出座位，確定要封鎖嗎？"))return;
    data.seating.slots[index]=null;
  }
  data.seating.blocked[index]=blocking;
  saveData();
  toast(blocking?"已封鎖此座位，不會加入隨機分配":"已解除座位封鎖");
}
function moveSeat(from,to){
  normalizeSeating();if(!Number.isInteger(from)||!Number.isInteger(to)||from===to||data.seating.blocked[from]||data.seating.blocked[to])return;
  [data.seating.slots[from],data.seating.slots[to]]=[data.seating.slots[to],data.seating.slots[from]];
  saveData();
  const seatRoom=document.getElementById("seatRoom");
  if(seatRoom)seatRoom.classList.toggle("front-step-reveal",seatRevealMode==="step");

}
function applySeatGrid(){
  normalizeSeating();
  const rows=Math.max(1,Math.min(10,Number(document.getElementById("seatRows")?.value)||5));
  const cols=Math.max(1,Math.min(10,Number(document.getElementById("seatCols")?.value)||3));
  if(rows*cols<data.students.length&&!confirm(`目前只有 ${rows*cols} 個座位，但班上有 ${data.students.length} 位學生。仍要套用嗎？`))return;
  data.seating.rows=rows;data.seating.cols=cols;normalizeSeating();saveData();
}
function normalizeLegacySeatRules(){
  normalizeSeating();
  const before=data.seating.rules.length;
  data.seating.rules=data.seating.rules.filter(r=>!["horizontal","orthogonal","front"].includes(r.kind));
  return data.seating.rules.length!==before;
}
function shuffleArray(arr){
  const out=[...arr];
  for(let i=out.length-1;i>0;i--){const k=Math.floor(Math.random()*(i+1));[out[i],out[k]]=[out[k],out[i]]}
  return out;
}
function seatAllowedByIndividualRules(studentId,index,rules,rows,cols){
  const rc=seatCoords(index,cols);
  for(const rule of rules){
    const ids=seatRuleIds(rule);
    if(!ids.includes(studentId))continue;
    if(rule.kind==="fixedSeat"&&index!==Number(rule.seatIndex))return false;
    if(rule.kind==="front2"&&rc.r>Math.min(1,rows-1))return false;
    if(rule.kind==="back2"&&rc.r<Math.max(0,rows-2))return false;
    if(rule.kind==="noCorner"){
      const corners=new Set([0,cols-1,(rows-1)*cols,rows*cols-1]);
      if(corners.has(index))return false;
    }
  }
  return true;
}
function seatAround8Conflict(studentId,index,slots,rules,cols){
  const A=seatCoords(index,cols);
  for(const rule of rules.filter(r=>r.kind==="around8")){
    const ids=seatRuleIds(rule);if(!ids.includes(studentId))continue;
    for(let i=0;i<slots.length;i++){
      if(!slots[i]||!ids.includes(slots[i]))continue;
      const B=seatCoords(i,cols);
      if(Math.max(Math.abs(A.r-B.r),Math.abs(A.c-B.c))===1)return true;
    }
  }
  return false;
}
function buildAdjacentCandidates(ids,availableSet,rules,rows,cols){
  const candidates=[];
  for(let r=0;r<rows;r++){
    for(let start=0;start<=cols-ids.length;start++){
      const seats=Array.from({length:ids.length},(_,i)=>r*cols+start+i);
      if(seats.every(i=>availableSet.has(i)))candidates.push(seats);
    }
  }
  return shuffleArray(candidates);
}
function solveSeatAssignment(){
  normalizeSeating();normalizeLegacySeatRules();
  const {rows,cols,blocked}=data.seating,count=rows*cols;
  const rules=data.seating.rules.filter(r=>r.enabled!==false);
  const students=data.students.map(s=>s.id),studentSet=new Set(students);
  const slots=Array(count).fill(null);
  const available=new Set([...Array(count).keys()].filter(i=>blocked[i]!==true));
  if(available.size<students.length)return null;

  // 將所有規則先正規化成「學生 -> 個別限制」與相鄰群組。
  const fixed=new Map(),aroundGroups=[],checkerboardGroups=[],adjacentGroups=[];
  for(const rule of rules){
    const ids=seatRuleIds(rule).filter(id=>studentSet.has(id));
    if(rule.kind==="fixedSeat"){
      if(ids.length!==1)return null;
      const idx=Number(rule.seatIndex),id=ids[0];
      if(!Number.isInteger(idx)||idx<0||idx>=count||blocked[idx])return null;
      if(fixed.has(id)&&fixed.get(id)!==idx)return null;
      fixed.set(id,idx);
    }else if(rule.kind==="around8"&&ids.length>1)aroundGroups.push(new Set(ids));
    else if(rule.kind==="checkerboard"&&ids.length>1)checkerboardGroups.push(new Set(ids));
    else if(rule.kind==="horizontalAdjacent"&&ids.length>1)adjacentGroups.push([...new Set(ids)]);
  }

  // 同一座位不可指定給不同學生。
  const fixedSeatOwner=new Map();
  for(const [id,idx] of fixed){
    if(fixedSeatOwner.has(idx)&&fixedSeatOwner.get(idx)!==id)return null;
    fixedSeatOwner.set(idx,id);
  }

  function individualAllowed(id,idx){
    if(fixed.has(id)&&fixed.get(id)!==idx)return false;
    return seatAllowedByIndividualRules(id,idx,rules,rows,cols);
  }
  function aroundConflict(id,idx){
    const A=seatCoords(idx,cols);
    for(const group of aroundGroups){
      if(!group.has(id))continue;
      for(let i=0;i<slots.length;i++){
        if(!slots[i]||!group.has(slots[i]))continue;
        const B=seatCoords(i,cols);
        if(Math.max(Math.abs(A.r-B.r),Math.abs(A.c-B.c))===1)return true;
      }
    }
    return false;
  }
  function checkerboardConflict(id,idx){
    const A=seatCoords(idx,cols);
    for(const group of checkerboardGroups){
      if(!group.has(id))continue;
      for(let i=0;i<slots.length;i++){
        if(!slots[i]||!group.has(slots[i]))continue;
        const B=seatCoords(i,cols);
        if(Math.abs(A.r-B.r)+Math.abs(A.c-B.c)===1)return true;
      }
    }
    return false;
  }
  function adjacentFeasible(group){
    const placed=group.filter(id=>slots.includes(id));
    if(!placed.length)return true;
    const positions=placed.map(id=>slots.indexOf(id)),coords=positions.map(i=>seatCoords(i,cols));
    if(coords.some(x=>x.r!==coords[0].r))return false;
    const row=coords[0].r;
    // 整組最後必須能塞進同一排的一段連續區間；枚舉仍可能成立的區間。
    for(let start=0;start<=cols-group.length;start++){
      const segment=Array.from({length:group.length},(_,k)=>row*cols+start+k);
      if(positions.some(p=>!segment.includes(p)))continue;
      let ok=true;
      for(const idx of segment){
        const occupant=slots[idx];
        if(occupant&&!group.includes(occupant)){ok=false;break}
        if(!occupant&&!available.has(idx)){ok=false;break}
      }
      if(ok)return true;
    }
    return false;
  }
  function allAdjacentFeasible(id){
    for(const group of adjacentGroups)if(group.includes(id)&&!adjacentFeasible(group))return false;
    return true;
  }

  // 固定座位先落位；此時也立刻驗證其他個別限制與八格限制。
  for(const [id,idx] of shuffleArray([...fixed.entries()])){
    if(!available.has(idx)||!individualAllowed(id,idx)||aroundConflict(id,idx)||checkerboardConflict(id,idx))return null;
    slots[idx]=id;available.delete(idx);
  }
  for(const group of adjacentGroups)if(!adjacentFeasible(group))return null;

  const unplaced=()=>students.filter(id=>!slots.includes(id));
  let nodes=0;
  const NODE_LIMIT=120000;

  function candidateSeats(id){
    return shuffleArray([...available].filter(idx=>{
      if(!individualAllowed(id,idx)||aroundConflict(id,idx)||checkerboardConflict(id,idx))return false;
      slots[idx]=id;available.delete(idx);
      const ok=allAdjacentFeasible(id);
      slots[idx]=null;available.add(idx);
      return ok;
    }));
  }

  function dfs(){
    if(++nodes>NODE_LIMIT)return false;
    const remaining=unplaced();
    if(!remaining.length)return !violatesSeatRules(slots);

    // MRV：每一步重新計算候選，讓固定座位、相鄰群組與八格規則可自由交疊。
    let chosen=null,candidates=null;
    for(const id of shuffleArray(remaining)){
      const cand=candidateSeats(id);
      if(!cand.length)return false;
      if(candidates===null||cand.length<candidates.length){chosen=id;candidates=cand;if(cand.length===1)break}
    }
    for(const idx of candidates){
      slots[idx]=chosen;available.delete(idx);
      if(allAdjacentFeasible(chosen)&&dfs())return true;
      slots[idx]=null;available.add(idx);
    }
    return false;
  }
  return dfs()?[...slots]:null;
}
function randomizeSeats(){
  normalizeSeating();
  const legacyChanged=normalizeLegacySeatRules();
  const count=data.seating.rows*data.seating.cols;
  const availableCount=[...Array(count).keys()].filter(i=>!data.seating.blocked[i]).length;
  if(availableCount<data.students.length){toast(`可分配座位不足：目前有 ${availableCount} 個未封鎖座位，班上有 ${data.students.length} 位學生`);return}
  const old=[...data.seating.slots],best=solveSeatAssignment();
  if(!best){if(legacyChanged)saveData();toast("目前座位格局與啟用規則彼此衝突，無法完成分配，請調整規則。");return}
  if(old.some(Boolean)){data.seating.history.unshift({id:uid("sh"),at:new Date().toISOString(),label:"隨機分配前",rows:data.seating.rows,cols:data.seating.cols,slots:old,blocked:[...data.seating.blocked]});data.seating.history=data.seating.history.slice(0,20)}
  data.seating.slots=best;saveData();toast("已依啟用規則完成座位分配");
}
function clearSeats(){
  if(!confirm("確定要清空目前座位安排嗎？"))return;
  normalizeSeating();data.seating.slots=Array(data.seating.rows*data.seating.cols).fill(null);saveData();
}
function toggleSeatView(){normalizeSeating();data.seating.view=data.seating.view==="teacher"?"student":"teacher";saveData()}
let seatRevealMode=localStorage.getItem("cmSeatRevealMode")==="direct"?"direct":"cards";
let seatCardRevealed=new Set();
function renderSeatCardPanel(){
  const panel=document.getElementById("seatCardPanel");if(!panel)return;
  const assigned=[...data.students].filter(s=>data.seating.slots.includes(s.id)).sort((a,b)=>a.number-b.number);
  panel.innerHTML=`<div class="seat-card-panel-head"><strong>學生字卡</strong><span id="seatCardProgress">${seatCardRevealed.size} / ${assigned.length} 已揭曉</span></div>
    <div class="seat-card-list">${assigned.map(s=>`<button type="button" class="seat-student-card ${seatCardRevealed.has(s.id)?"flipped":""}" data-seat-card-student="${s.id}" ${seatCardRevealed.has(s.id)?"disabled":""}>
      <span class="seat-student-card-inner"><span class="seat-student-card-front"><b>${String(s.number).padStart(2,"0")}</b>${escapeHtml(s.name)}</span><span class="seat-student-card-back">已揭曉</span></span>
    </button>`).join("")||`<div class="empty">目前尚未分配座位。</div>`}</div>`;
  panel.querySelectorAll("[data-seat-card-student]").forEach(btn=>btn.addEventListener("click",()=>revealSeatByStudent(btn.dataset.seatCardStudent)));
}
function revealSeatByStudent(studentId){
  if(seatRevealMode!=="cards"||seatCardRevealed.has(studentId))return;
  const seat=document.querySelector(`.seat-slot[data-student-id="${studentId}"]`);
  const card=document.querySelector(`[data-seat-card-student="${studentId}"]`);
  if(!seat||!card)return;
  seatCardRevealed.add(studentId);
  card.classList.add("flipped");card.disabled=true;
  seat.classList.add("revealed","card-revealed");
  const progress=document.getElementById("seatCardProgress");
  if(progress){
    const total=document.querySelectorAll("[data-seat-card-student]").length;
    progress.textContent=`${seatCardRevealed.size} / ${total} 已揭曉`;
  }
}
function setSeatRevealMode(mode){
  seatRevealMode=mode==="direct"?"direct":"cards";
  localStorage.setItem("cmSeatRevealMode",seatRevealMode);
  document.querySelectorAll("[data-seat-reveal-mode]").forEach(btn=>btn.classList.toggle("active",btn.dataset.seatRevealMode===seatRevealMode));
  const room=document.getElementById("seatRoom");
  if(room){
    room.classList.remove("front-step-reveal");
    room.classList.toggle("front-card-reveal",seatRevealMode==="cards");
    if(seatRevealMode==="direct")room.querySelectorAll(".seat-slot").forEach(el=>el.classList.remove("revealed","card-revealed"));
  }
}
function toggleSeatPresentation(forceOff=false){
  const room=document.getElementById("seatRoom");if(!room)return;
  const entering=forceOff===true?false:!room.classList.contains("presentation");
  room.classList.toggle("presentation",entering);
  room.classList.remove("step-reveal");
  room.classList.toggle("card-reveal",entering&&seatRevealMode==="cards");
  document.body.classList.toggle("seat-presentation-active",entering);
  document.getElementById("seatPresentationBtn").textContent=entering?"展示中":"展示模式";
  let back=document.getElementById("seatPresentationBackBtn");
  if(entering){
    seatCardRevealed=new Set();
    room.querySelectorAll(".seat-slot").forEach(el=>el.classList.remove("revealed","card-revealed"));
    if(seatRevealMode==="cards")renderSeatCardPanel();
    if(!back){back=document.createElement("button");back.id="seatPresentationBackBtn";back.className="seat-presentation-back";back.textContent="← 返回座位管理";back.addEventListener("click",()=>toggleSeatPresentation(true));room.prepend(back)}
  }else{
    seatCardRevealed=new Set();
    const panel=document.getElementById("seatCardPanel");if(panel)panel.replaceChildren();
    room.classList.remove("card-reveal");
    if(back)back.remove();
  }
}
function renderStudents(){
  const q = document.getElementById("studentSearch").value.trim().toLowerCase();
  let students = [...data.students].sort((a,b)=>a.number-b.number);
  if(q){
    students = students.filter(s=>String(s.number).includes(q) || s.name.toLowerCase().includes(q));
  }
  const list = document.getElementById("studentList");
  if(!students.length){
    list.innerHTML = `<div class="empty">尚未建立學生名單，請到班級首頁的「班級資料管理」加入學生。</div>`;
    return;
  }
  list.innerHTML = students.map(s=>{
    const rs = data.records.filter(r=>r.studentId===s.id);
    const missing = rs.filter(r=>r.status==="missing").length;
    const correction = rs.filter(r=>r.status==="correction").length;
    return `
      <div class="student-card" onclick="openStudent('${s.id}')">
        <div class="num">${String(s.number).padStart(2,"0")}</div>
        <div class="item-title">${escapeHtml(s.name)}</div>
        ${s.tags?.length?`<div class="student-tags">${s.tags.map(t=>`<span>${escapeHtml(t)}</span>`).join("")}</div>`:""}
        <div class="assignment-summary">
          ${missing ? `<span class="badge missing">缺交 ${missing}</span>`:""}
          ${correction ? `<span class="badge correction">待訂正 ${correction}</span>`:""}
          ${(!missing && !correction) ? `<span class="badge clear">目前無待處理</span>`:""}
        </div>
      </div>
    `;
  }).join("");
}

function renderSettingsRoster(){
  const text = [...data.students]
    .sort((a,b)=>a.number-b.number)
    .map(s=>`${s.number} ${s.name}`)
    .join("\n");
  const ta = document.getElementById("studentRosterInput");
  if(ta && document.activeElement !== ta) ta.value = text;
}


let assignmentStudentSortMode=localStorage.getItem("cmAssignmentStudentSort")==="group"?"group":"number";
function normalizeAssignmentGroups(){if(!Array.isArray(data.assignmentGroups))data.assignmentGroups=[];const valid=new Set(data.students.map(s=>s.id)),seen=new Set();data.assignmentGroups=data.assignmentGroups.map((g,i)=>({id:g.id||uid("ag"),name:g.name||`第 ${i+1} 組`,studentIds:(Array.isArray(g.studentIds)?g.studentIds:[]).filter(id=>valid.has(id)&&!seen.has(id)&&seen.add(id))}))}
function assignmentGroupForStudent(id){normalizeAssignmentGroups();return data.assignmentGroups.find(g=>g.studentIds.includes(id))}
function assignmentSortedStudents(){normalizeAssignmentGroups();if(assignmentStudentSortMode!=="group")return [...data.students].sort((a,b)=>a.number-b.number);const order=new Map();data.assignmentGroups.forEach((g,i)=>g.studentIds.forEach(id=>order.set(id,i)));return [...data.students].sort((a,b)=>(order.get(a.id)??999)-(order.get(b.id)??999)||a.number-b.number)}
function assignmentGroupHeadingHtml(s,i,list){if(assignmentStudentSortMode!=="group")return "";const g=assignmentGroupForStudent(s.id),p=i?assignmentGroupForStudent(list[i-1].id):null;if(i&&g?.id===p?.id)return "";if(i&&!g&&!p)return "";return `<div class="assignment-group-heading">${escapeHtml(g?.name||"未分組")}</div>`}
function setAssignmentStudentSort(mode,id){assignmentStudentSortMode=mode==="group"?"group":"number";localStorage.setItem("cmAssignmentStudentSort",assignmentStudentSortMode);openAssignment(id)}
function openAssignmentGroups(){normalizeAssignmentGroups();if(!data.assignmentGroups.length)data.assignmentGroups=[{id:uid("ag"),name:"第 1 組",studentIds:[]}];const opts=data.assignmentGroups.map((g,i)=>`<option value="${g.id}">${escapeHtml(g.name||`第 ${i+1} 組`)}</option>`).join("");const rows=[...data.students].sort((a,b)=>a.number-b.number).map(s=>{const cur=assignmentGroupForStudent(s.id)?.id||"";return `<div class="manual-group-row"><div class="manual-student">${String(s.number).padStart(2,"0")} ${escapeHtml(s.name)}</div><select data-assignment-group-student="${s.id}"><option value="">未分組</option>${opts.replace(`value="${cur}"`,`value="${cur}" selected`)}</select></div>`}).join("");showModal("作業小組設定",`<div class="modal-form"><div class="manual-group-top"><label><span>小組數量</span><input id="assignmentGroupCount" type="number" min="1" max="20" value="${data.assignmentGroups.length}"></label><button type="button" class="secondary" onclick="rebuildAssignmentGroups()">套用組數</button></div><div class="notice-box">作業小組獨立於課堂工具的小組積分。</div><div class="assignment-group-name-list">${data.assignmentGroups.map((g,i)=>`<label><span>第 ${i+1} 組名稱</span><input data-assignment-group-name="${g.id}" value="${escapeAttr(g.name)}"></label>`).join("")}</div><div class="manual-group-list">${rows}</div><div class="modal-actions"><button type="button" class="secondary" onclick="closeModal()">取消</button><button type="button" class="primary" onclick="saveAssignmentGroups()">儲存作業小組</button></div></div>`)}
function rebuildAssignmentGroups(){
  const n=Math.max(1,Math.min(20,Number(document.getElementById("assignmentGroupCount")?.value)||1));
  normalizeAssignmentGroups();
  document.querySelectorAll("[data-assignment-group-name]").forEach(x=>{
    const g=data.assignmentGroups.find(g=>g.id===x.dataset.assignmentGroupName);
    if(g)g.name=x.value.trim()||g.name;
  });
  const currentMembership=new Map();
  document.querySelectorAll("[data-assignment-group-student]").forEach(x=>currentMembership.set(x.dataset.assignmentGroupStudent,x.value));
  const old=[...data.assignmentGroups];
  data.assignmentGroups=Array.from({length:n},(_,i)=>old[i]||{id:uid("ag"),name:`第 ${i+1} 組`,studentIds:[]});
  const validGroups=new Set(data.assignmentGroups.map(g=>g.id));
  data.assignmentGroups.forEach(g=>g.studentIds=[]);
  currentMembership.forEach((groupId,studentId)=>{
    const g=data.assignmentGroups.find(g=>g.id===groupId);
    if(g&&validGroups.has(groupId))g.studentIds.push(studentId);
  });
  openAssignmentGroups();
}
function saveAssignmentGroups(){normalizeAssignmentGroups();data.assignmentGroups.forEach(g=>g.studentIds=[]);document.querySelectorAll("[data-assignment-group-name]").forEach(x=>{const g=data.assignmentGroups.find(g=>g.id===x.dataset.assignmentGroupName);if(g)g.name=x.value.trim()||g.name});document.querySelectorAll("[data-assignment-group-student]").forEach(x=>{const g=data.assignmentGroups.find(g=>g.id===x.value);if(g)g.studentIds.push(x.dataset.assignmentGroupStudent)});persistActiveClass();closeModal();renderDashboard();toast("作業小組已儲存")}

function openAssignment(id){
  const a=data.assignments.find(x=>x.id===id);if(!a)return;const students=assignmentSortedStudents();
  showModal(`${a.title}`,`<div class="assignment-modal-top"><div class="item-sub">${formatDate(a.date)}</div><div class="assignment-sort-switch"><button class="secondary ${assignmentStudentSortMode==="number"?"active":""}" onclick="setAssignmentStudentSort('number','${a.id}')">座號排序</button><button class="secondary ${assignmentStudentSortMode==="group"?"active":""}" onclick="setAssignmentStudentSort('group','${a.id}')">作業小組排序</button></div></div><div class="tracker-grid assignment-tracker-grid">${students.map((s,i)=>{const r=ensureRecord(a.id,s.id);return `${assignmentGroupHeadingHtml(s,i,students)}<div class="tracker-tile"><div class="tracker-tile-head"><span class="student-no">${String(s.number).padStart(2,"0")}</span><span class="student-name">${escapeHtml(s.name)}</span></div><select class="status-select ${r.status}" onchange="setStatus('${a.id}','${s.id}',this)">${STATUS_ORDER.map(st=>`<option value="${st}" ${r.status===st?"selected":""}>${STATUS_LABEL[st]}</option>`).join("")}</select><input class="note-input" placeholder="備註" value="${escapeAttr(r.note||"")}" onchange="updateNote('${a.id}','${s.id}',this.value)" /></div>`}).join("")}</div><div class="modal-actions"><button class="secondary" onclick="deleteAssignment('${a.id}')">刪除作業</button><button class="primary" onclick="closeModal()">完成</button></div>`);persistActiveClass()
}

function setStatus(assignmentId, studentId, select){
  const r = ensureRecord(assignmentId, studentId);
  r.status = select.value;
  persistActiveClass();
  select.className = `status-select ${r.status}`;
  // 保留目前下拉選單即時更新；其餘統計只更新使用者正在看的頁面。
  renderPage(currentPage);
  if(r.status === "completed"){
    maybeArchiveCompletedAssignment(assignmentId);
  }
}

function maybeArchiveCompletedAssignment(assignmentId){
  const a = data.assignments.find(x=>x.id===assignmentId);
  if(!a || a.dashboardArchived || !data.students.length) return;
  const {percent} = assignmentProgress(assignmentId);
  if(percent !== 100) return;
  const shouldArchive = confirm(`「${a.title}」完成率已達 100%！\n\n是否從總覽的待處理作業清單移除？\n（作業與學生歷史紀錄仍會保留）`);
  if(shouldArchive){
    a.dashboardArchived = true;
    persistActiveClass();
    renderPage(currentPage);
    toast("作業已完成，已從總覽移除 🎉");
  }
}

function updateNote(assignmentId, studentId, note){
  const r = ensureRecord(assignmentId, studentId);
  r.note = note.trim();
  persistActiveClass();
}

function studentIssueDetailsHtml(history){
  const groups=[
    {status:"correction",label:"待訂正",items:history.filter(x=>x.r.status==="correction")},
    {status:"missing",label:"缺交",items:history.filter(x=>x.r.status==="missing")}
  ].filter(g=>g.items.length);
  if(!groups.length) return `<div class="student-issue-clear">目前沒有待訂正或缺交的作業。</div>`;
  return `<div class="student-issue-details">${groups.map(g=>`
    <section class="student-issue-group ${g.status}">
      <div class="student-issue-heading"><span>${g.label}</span><b>${g.items.length} 項</b></div>
      <div class="student-issue-list">
        ${g.items.map(x=>`
          <button type="button" class="student-issue-item" onclick="closeModal();openAssignment('${x.a.id}')">
            <span class="student-issue-title">${escapeHtml(x.a.title)}</span>
            <span class="student-issue-date">${formatDate(x.a.date)}</span>
          </button>`).join("")}
      </div>
    </section>`).join("")}</div>`;
}

function openStudent(studentId){
  const s = data.students.find(x=>x.id===studentId);
  if(!s) return;
  const history = data.assignments
    .map(a=>({a, r:getRecord(a.id,s.id)}))
    .filter(x=>x.r && x.r.status!=="completed")
    .sort((x,y)=>y.a.date.localeCompare(x.a.date));
  showModal(
    `${String(s.number).padStart(2,"0")} ${s.name}`,
    `
      <div class="assignment-summary">
        <span class="badge missing">缺交 ${history.filter(x=>x.r.status==="missing").length}</span>
        <span class="badge correction">待訂正 ${history.filter(x=>x.r.status==="correction").length}</span>
      </div>
      ${studentIssueDetailsHtml(history)}
      <div class="tracker-list">
        ${history.length ? history.map(x=>`
          <div class="item-card clickable" onclick="closeModal();openAssignment('${x.a.id}')">
            <div class="item-main">
              <div class="item-title">${escapeHtml(x.a.title)}</div>
              <div class="item-sub">${formatDate(x.a.date)}${x.r.note?`｜${escapeHtml(x.r.note)}`:""}</div>
            </div>
            <span class="badge ${x.r.status}">${STATUS_LABEL[x.r.status]}</span>
          </div>
        `).join("") : `<div class="empty">尚無作業紀錄。</div>`}
      </div>
    `
  );
}

function openNewAssignment(){
  if(!data.students.length){
    toast("請先回到班級首頁，在「班級資料管理」建立學生名單");
    return;
  }
  showModal(
    "新增作業",
    `
      <form id="newAssignmentForm" class="modal-form">
        <label><span>日期</span><input type="date" id="newDate" value="${localDateString()}" required></label>
        <label><span>作業名稱</span><input id="newTitle" placeholder="例如：數學習作 P.42" required></label>
        <div class="modal-actions">
          <button type="button" class="secondary" onclick="closeModal()">取消</button>
          <button class="primary" type="submit">建立作業</button>
        </div>
      </form>
    `
  );
  document.getElementById("newAssignmentForm").addEventListener("submit", e=>{
    e.preventDefault();
    const assignment = {
      id:uid("a"),
      date:document.getElementById("newDate").value,
      subject:"",
      title:document.getElementById("newTitle").value.trim(),
      createdAt:new Date().toISOString(),
      dashboardArchived:false
    };
    data.assignments.push(assignment);
    data.students.forEach(s=>{
      data.records.push({assignmentId:assignment.id, studentId:s.id, status:"pending", note:""});
    });

    const assignmentFilter = document.getElementById("assignmentDateFilter");
    if(assignmentFilter) assignmentFilter.value = assignment.date;
    showAllAssignmentsMode = false;
    const allAssignmentsBtn = document.getElementById("showAllAssignments");
    if(allAssignmentsBtn) allAssignmentsBtn.textContent = "顯示全部";

    saveData();
    closeModal();
    renderAssignments();
    openAssignment(assignment.id);
  });
}

function deleteAssignment(id){
  if(!confirm("確定要刪除這項作業及其所有紀錄嗎？")) return;
  data.assignments = data.assignments.filter(a=>a.id!==id);
  data.records = data.records.filter(r=>r.assignmentId!==id);
  saveData();
  closeModal();
  toast("作業已刪除");
}

function parseRoster(text){
  const lines = text.split(/\n/).map(x=>x.trim()).filter(Boolean);
  return lines.map((line,i)=>{
    const match = line.match(/^(\d+)\s+(.+)$/);
    if(match) return {number:Number(match[1]), name:match[2].trim()};
    return {number:i+1, name:line};
  });
}

function saveClassSettings(e){
  e.preventDefault();
  const className = document.getElementById("classNameInput").value.trim();
  const roster = parseRoster(document.getElementById("studentRosterInput").value);
  const oldByNumber = new Map(data.students.map(s=>[s.number,s]));

  const newStudents = roster.map(item=>{
    const old = oldByNumber.get(item.number);
    if(old) return {...old, name:item.name};
    return {id:uid("s"), number:item.number, name:item.name};
  });

  const validIds = new Set(newStudents.map(s=>s.id));
  data.records = data.records.filter(r=>validIds.has(r.studentId));
  data.students = newStudents;
  data.class.name = className;

  data.assignments.forEach(a=>{
    data.students.forEach(s=>{
      if(!getRecord(a.id,s.id)){
        data.records.push({assignmentId:a.id, studentId:s.id, status:"pending", note:""});
      }
    });
  });

  saveData();
  toast("班級資料已儲存");
}

function exportBackup(){
  const backup = {
    ...data,
    backupDate:new Date().toISOString()
  };
  const blob = new Blob([JSON.stringify(backup,null,2)],{type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeClass = (data.class.name || "班級").replace(/[\\/:*?"<>|]/g,"-");
  a.href = url;
  a.download = `作業追蹤備份-${safeClass}-${localDateString()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast("備份檔已匯出");
}

async function importBackup(file){
  if(!file) return;
  try{
    const text = await file.text();
    const parsed = JSON.parse(text);
    const candidate = normalizeData(parsed);
    const summary = `班級：${candidate.class.name || "未命名"}\n學生：${candidate.students.length} 人\n作業：${candidate.assignments.length} 項\n紀錄：${candidate.records.length} 筆\n\n匯入後會取代目前瀏覽器中的資料，確定繼續嗎？`;
    if(!confirm(summary)) return;
    data = candidate;
    saveData();
    toast("備份匯入完成");
  }catch(e){
    alert("無法匯入這個檔案，請確認它是由本網站匯出的 JSON 備份。");
  }finally{
    document.getElementById("importInput").value="";
  }
}

function clearAllData(){
  const first = confirm("這會清除目前班級中的所有學生、作業與聯絡簿紀錄。要繼續嗎？");
  if(!first) return;
  const second = confirm("再次確認：清除後若沒有備份，資料無法復原。");
  if(!second) return;
  const className = data.class.name;
  data = defaultData();
  data.class.name = className;
  saveData();
  toast("目前班級資料已清除");
}

function showModal(title, bodyHtml){
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalBody").innerHTML = bodyHtml;
  document.getElementById("modalBackdrop").classList.remove("hidden");
}

function closeModal(){
  document.getElementById("modalBackdrop").classList.add("hidden");
}

function toast(msg){
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(()=>el.classList.add("hidden"),1800);
}

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, s=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[s]));
}
function escapeAttr(str){ return escapeHtml(str); }

const drawStudentBtn=document.getElementById("drawStudentBtn");
if(drawStudentBtn) drawStudentBtn.addEventListener("click",drawRandomStudent);
const resetLotteryBtn=document.getElementById("resetLotteryBtn");
if(resetLotteryBtn) resetLotteryBtn.addEventListener("click",resetLottery);
document.querySelectorAll(".lottery-mode-btn").forEach(btn=>btn.addEventListener("click",()=>{
  const nextMode=btn.dataset.lotteryMode;
  if(nextMode!=="without-replacement" && nextMode!=="with-replacement") return;
  lotteryMode=nextMode;
  lotteryDrawnIds=[];
  lotteryLastStudentId=null;
  renderLottery();
}));

document.querySelectorAll(".timer-preset").forEach(btn=>btn.addEventListener("click",()=>{
  document.querySelectorAll(".timer-preset").forEach(x=>x.classList.toggle("active",x===btn));
  setPomodoroDuration(Number(btn.dataset.minutes),btn.dataset.label);
}));
const applyCustomTimerBtn=document.getElementById("applyCustomTimerBtn");
if(applyCustomTimerBtn) applyCustomTimerBtn.addEventListener("click",()=>{
  const input=document.getElementById("customTimerMinutes");
  const minutes=Math.max(1,Math.min(180,Number(input?.value)||10));
  if(input) input.value=String(minutes);
  document.querySelectorAll(".timer-preset").forEach(x=>x.classList.remove("active"));
  setPomodoroDuration(minutes,`自訂 ${minutes} 分鐘`);
});
const timerStartPauseBtn=document.getElementById("timerStartPauseBtn");
if(timerStartPauseBtn) timerStartPauseBtn.addEventListener("click",togglePomodoro);
const timerResetBtn=document.getElementById("timerResetBtn");
if(timerResetBtn) timerResetBtn.addEventListener("click",resetPomodoro);

document.querySelectorAll(".tab").forEach(btn=>btn.addEventListener("click",()=>setPage(btn.dataset.page)));
document.getElementById("addClassBtn").addEventListener("click",openAddClass);
document.getElementById("classDataBtn").addEventListener("click",openClassDataPanel);
document.getElementById("backToClassHome").addEventListener("click",leaveClass);
const noticeMemoBtn = document.getElementById("noticeMemoBtn");
if(noticeMemoBtn){
  noticeMemoBtn.addEventListener("click", openNoticeMemo);
}
document.getElementById("addAssignmentBtn").addEventListener("click",openNewAssignment);
document.getElementById("assignmentGroupsBtn")?.addEventListener("click",openAssignmentGroups);
document.getElementById("assignmentDateFilter").addEventListener("change",()=>{
  showAllAssignmentsMode=false;
  renderAssignments();
});
document.getElementById("showAllAssignments").addEventListener("click",()=>{
  showAllAssignmentsMode=!showAllAssignmentsMode;
  document.getElementById("showAllAssignments").textContent = showAllAssignmentsMode ? "依日期篩選" : "顯示全部";
  renderAssignments();
});
document.getElementById("contactDateFilter").addEventListener("change",()=>{
  showAllContactItemsMode=false;
  renderContactBook();
});
document.getElementById("showAllContactItems").addEventListener("click",()=>{
  showAllContactItemsMode=!showAllContactItemsMode;
  document.getElementById("showAllContactItems").textContent = showAllContactItemsMode ? "依日期篩選" : "顯示全部";
  renderContactBook();
});
document.getElementById("addContactItemBtn").addEventListener("click",openNewContactItem);
document.getElementById("studentSearch").addEventListener("input",renderStudents);
document.getElementById("classForm").addEventListener("submit",saveClassSettings);
document.getElementById("exportBtn").addEventListener("click",exportBackup);
document.getElementById("importInput").addEventListener("change",e=>importBackup(e.target.files[0]));
document.getElementById("clearBtn").addEventListener("click",clearAllData);
document.getElementById("modalClose").addEventListener("click",closeModal);
document.getElementById("modalBackdrop").addEventListener("click",e=>{
  if(e.target.id==="modalBackdrop") closeModal();
});

// v3.26 classroom tool bindings
document.querySelectorAll(".score-mode-tab").forEach(btn=>{
  btn.addEventListener("click",()=>setScoreMode(btn.dataset.scoreMode));
});
const marqueeInputEl=document.getElementById("marqueeInput");
if(marqueeInputEl) marqueeInputEl.addEventListener("input",renderMarquee);
const marqueeSpeedEl=document.getElementById("marqueeSpeed");
if(marqueeSpeedEl) marqueeSpeedEl.addEventListener("change",renderMarquee);
const marqueeStartEl=document.getElementById("marqueeStartBtn");
if(marqueeStartEl) marqueeStartEl.addEventListener("click",startMarquee);
const marqueeStopEl=document.getElementById("marqueeStopBtn");
if(marqueeStopEl) marqueeStopEl.addEventListener("click",stopMarquee);
document.querySelectorAll(".noise-mode-btn").forEach(btn=>btn.addEventListener("click",()=>setNoiseMode(btn.dataset.noiseMode)));
noiseEl("noiseStartBtn")?.addEventListener("click",startNoiseMonitor);
noiseEl("noiseStopBtn")?.addEventListener("click",stopNoiseMonitor);
noiseEl("challengeResetBtn")?.addEventListener("click",resetChallenge);
["noiseSensitivity","noiseThreshold","noiseHold","noiseCooldown","noiseAlertMode","challengeTarget"].forEach(id=>noiseEl(id)?.addEventListener("input",renderNoiseTool));
document.querySelectorAll("[data-noise-standard]").forEach(btn=>btn.addEventListener("click",()=>setNoiseStandard(btn.dataset.noiseStandard)));
noiseEl("noiseCalibrateBtn")?.addEventListener("click",startNoiseCalibration);
noiseEl("noiseThreshold")?.addEventListener("input",()=>{noiseStandard="custom";renderNoiseTool()});


renderClassHome();

startDateRolloverGuards();



document.getElementById("applySeatGridBtn")?.addEventListener("click",applySeatGrid);
document.getElementById("randomSeatsBtn")?.addEventListener("click",randomizeSeats);
document.getElementById("clearSeatsBtn")?.addEventListener("click",clearSeats);
document.getElementById("seatViewBtn")?.addEventListener("click",toggleSeatView);
document.getElementById("seatPresentationBtn")?.addEventListener("click",()=>toggleSeatPresentation(false));
document.querySelectorAll("[data-seat-reveal-mode]").forEach(btn=>btn.addEventListener("click",()=>setSeatRevealMode(btn.dataset.seatRevealMode)));
setSeatRevealMode(seatRevealMode);

document.getElementById("seatSettingsBtn")?.addEventListener("click",openSeatSettings);
document.getElementById("seatHistoryBtn")?.addEventListener("click",openSeatHistory);
document.getElementById("saveSeatSnapshotBtn")?.addEventListener("click",()=>saveSeatHistory("手動儲存"));
