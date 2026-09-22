const APP_VERSION = "1.1";

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
    students:Array.isArray(input?.students) ? input.students : [],
    assignments:Array.isArray(input?.assignments) ? input.assignments : [],
    records:Array.isArray(input?.records) ? input.records : [],
    contactItems:Array.isArray(input?.contactItems)
      ? input.contactItems
      : (Array.isArray(input?.contactBook) ? input.contactBook : []),
    notices:Array.isArray(input?.notices) ? input.notices : [],
    memos:Array.isArray(input?.memos) ? input.memos : [],
    scores:(input?.scores && typeof input.scores==="object") ? input.scores : {},
    groups:Array.isArray(input?.groups) ? input.groups : [],
    groupScores:(input?.groupScores && typeof input.groupScores==="object") ? input.groupScores : {},
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
  renderAll();
  renderClassHome();
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
  renderAll();
}

function leaveClass(){
  persistActiveClass();
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

function setPage(page){
  currentPage = page;
  document.querySelectorAll(".page").forEach(el=>el.classList.toggle("active", el.id===page));
  document.querySelectorAll(".tab").forEach(el=>el.classList.toggle("active", el.dataset.page===page));
  renderAll();
}


let __lastRenderedDate = localDateString();

function refreshForDateRollover(){
  const currentDate = localDateString();
  if(currentDate === __lastRenderedDate) return;
  __lastRenderedDate = currentDate;
  renderAll();
}

function startDateRolloverGuards(){
  // 第一層：頁面持續開啟時，定期檢查是否跨日。
  window.setInterval(refreshForDateRollover, 60000);

  // 第二層：從背景切回、重新聚焦時，立即檢查一次。
  document.addEventListener("visibilitychange", ()=>{
    if(document.visibilityState === "visible"){
      refreshForDateRollover();
    }
  });
  window.addEventListener("focus", refreshForDateRollover);
}

function renderAll(){
  __lastRenderedDate = localDateString();
  document.getElementById("todayText").textContent = formatToday();
  const className = data.class.name || "尚未設定班級";
  document.getElementById("headerClassName").textContent = data.class.name || "Classroom Manager";
  document.getElementById("dashboardClassName").textContent = className;
  renderDashboard();
  renderTodayNotices();
  renderMemoSummary();
  renderAssignments();
  renderContactBook();
  renderStudents();
  renderScores();
  renderGroupScores();
  renderLottery();
  renderPomodoro();
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
  const students=[...data.students].sort((x,y)=>x.number-y.number);
  return `
    <article class="submission-overview-card">
      <div class="submission-overview-title">
        <div>
          <div class="item-title">${escapeHtml(a.title)}</div>
          <div class="item-sub">${formatDate(a.date)} · 完成 ${c.completed} / ${total}</div>
        </div>
        <div class="rate-pill ${percent===100 ? "done" : ""}">${percent}%</div>
      </div>
      <div class="submission-student-grid">
        ${students.map(s=>{
          const r=ensureRecord(a.id,s.id);
          return `
            <label class="submission-student-cell">
              <span class="submission-student-name">${escapeHtml(String(s.number).padStart(2,"0"))} ${escapeHtml(s.name)}</span>
              <select class="status-select ${r.status}" aria-label="${escapeAttr(s.name)}的作業狀態"
                onchange="setStatus('${a.id}','${s.id}',this)">
                ${STATUS_ORDER.map(status=>`<option value="${status}" ${r.status===status ? "selected" : ""}>${STATUS_LABEL[status]}</option>`).join("")}
              </select>
            </label>`;
        }).join("")}
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

  let items = [...data.contactItems].sort((a,b)=> b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
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
          <div class="contact-date">${formatDate(i.date)}</div>
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
          <button class="ghost-danger small-btn" onclick="deleteContactItem('${i.id}')">刪除</button>
        </div>
      </div>`;
  }).join("");
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
  saveData();
  toast("聯絡事項已刪除");
}



let currentScoreMode = "individual";

function setScoreMode(mode){
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

function noiseSettings(){return {sensitivity:Number(noiseEl("noiseSensitivity")?.value||100),threshold:Number(noiseEl("noiseThreshold")?.value||65),hold:Number(noiseEl("noiseHold")?.value||2)*1000,cooldown:Number(noiseEl("noiseCooldown")?.value||10)*1000,alertMode:noiseEl("noiseAlertMode")?.value||"both",target:Number(noiseEl("challengeTarget")?.value||300)*1000}}
function renderNoiseTool(){
  noiseEl("challengeBox")?.classList.toggle("hidden",noiseMode!=="challenge"); noiseEl("challengeTargetSetting")?.classList.toggle("hidden",noiseMode!=="challenge");
  document.querySelectorAll(".noise-mode-btn").forEach(b=>b.classList.toggle("active",b.dataset.noiseMode===noiseMode));
  const s=noiseSettings();
  if(noiseEl("sensitivityValue")) noiseEl("sensitivityValue").textContent=`${s.sensitivity}%`;
  document.querySelectorAll("[data-sensitivity]").forEach(b=>b.classList.toggle("active",Number(b.dataset.sensitivity)===s.sensitivity));
  if(noiseEl("thresholdValue"))noiseEl("thresholdValue").textContent=`${s.threshold}%`; if(noiseEl("noiseThresholdMark"))noiseEl("noiseThresholdMark").style.left=`${s.threshold}%`;
  if(noiseEl("challengeTargetLabel"))noiseEl("challengeTargetLabel").textContent=formatNoiseTime(s.target); renderChallengeTime(); requestAnimationFrame(t=>drawNoiseBallPool(t,noiseActive?noiseLevel:0,false));
}
function formatNoiseTime(ms){const sec=Math.floor(ms/1000),m=Math.floor(sec/60),s=sec%60;return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`}
function renderChallengeTime(){if(noiseEl("challengeElapsed"))noiseEl("challengeElapsed").textContent=formatNoiseTime(challengeElapsedMs)}
function setNoiseMode(mode){noiseMode=mode; resetChallenge(); renderNoiseTool()}
function resetChallenge(){challengeElapsedMs=0;challengeLastTick=performance.now();challengeComplete=false;renderChallengeTime();if(noiseEl("challengeState"))noiseEl("challengeState").textContent=noiseActive?"挑戰進行中":"等待開始偵測"}
async function startNoiseMonitor(){
  if(noiseActive)return;
  if(!navigator.mediaDevices?.getUserMedia){toast("此瀏覽器不支援麥克風音量偵測");return}
  try{
    noiseStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
    noiseAudioContext=new (window.AudioContext||window.webkitAudioContext)(); await noiseAudioContext.resume();
    const source=noiseAudioContext.createMediaStreamSource(noiseStream); noiseAnalyser=noiseAudioContext.createAnalyser(); noiseAnalyser.fftSize=1024; noiseAnalyser.smoothingTimeConstant=.72; source.connect(noiseAnalyser);
    noiseActive=true;noiseOverSince=0;challengeLastTick=performance.now();noiseEl("noiseStartBtn").disabled=true;noiseEl("noiseStopBtn").disabled=false;if(noiseEl("noiseStatus"))noiseEl("noiseStatus").textContent="偵測中";noiseLoop();
  }catch(err){console.warn("Microphone unavailable",err);toast("無法使用麥克風，請確認瀏覽器權限");if(noiseEl("noiseStatus"))noiseEl("noiseStatus").textContent="麥克風未授權"}
}
function stopNoiseMonitor(){
  if(noiseFrame)cancelAnimationFrame(noiseFrame);noiseFrame=0;noiseActive=false;noiseStream?.getTracks().forEach(t=>t.stop());noiseStream=null;if(noiseAudioContext&&noiseAudioContext.state!=="closed")noiseAudioContext.close().catch(()=>{});noiseAudioContext=null;noiseAnalyser=null;
  const start=noiseEl("noiseStartBtn"),stop=noiseEl("noiseStopBtn");if(start)start.disabled=false;if(stop)stop.disabled=true;if(noiseEl("noiseStatus"))noiseEl("noiseStatus").textContent="已停止";if(noiseEl("noiseMessage"))noiseEl("noiseMessage").textContent="偵測已停止";if(noiseEl("noiseMeterFill"))noiseEl("noiseMeterFill").style.width="0%";noiseBallEnergy=0;drawNoiseBallPool(performance.now(),0,false)
}
function noiseLoop(now=performance.now()){
  if(!noiseActive||!noiseAnalyser)return; const arr=new Uint8Array(noiseAnalyser.fftSize);noiseAnalyser.getByteTimeDomainData(arr);let sum=0;for(const v of arr){const x=(v-128)/128;sum+=x*x}const rms=Math.sqrt(sum/arr.length);
  const sensitivity=noiseSettings().sensitivity/20; // v1.1：新 100% = v1.0 的 50%
  noiseLevel=Math.max(0,Math.min(100,Math.round(Math.pow(Math.min(1,rms*5.5*sensitivity),.72)*100))); updateNoiseVisual(now);noiseFrame=requestAnimationFrame(noiseLoop)
}
function updateNoiseVisual(now){
  const s=noiseSettings(),over=noiseLevel>=s.threshold,fill=noiseEl("noiseMeterFill");if(fill)fill.style.width=`${noiseLevel}%`;if(noiseEl("noiseLevelText"))noiseEl("noiseLevelText").textContent=`${noiseLevel}%`;
  drawNoiseBallPool(now,noiseLevel,over);
  if(over){if(!noiseOverSince)noiseOverSince=now;const held=now-noiseOverSince>=s.hold;if(noiseEl("noiseMessage"))noiseEl("noiseMessage").textContent=held?"🔔 音量超過警戒值":"音量偏高…";if(held&&now-noiseLastAlert>=s.cooldown){noiseLastAlert=now;triggerNoiseAlert(s.alertMode)}}else{noiseOverSince=0;if(noiseEl("noiseMessage"))noiseEl("noiseMessage").textContent=noiseLevel<35?"很安靜 👍":"音量正常"}
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
          <button class="score-btn plus" onclick="changeStudentScore('${s.id}',1)">＋</button>
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
          <button class="score-btn plus" onclick="changeGroupScore('${g.id}',1)">＋</button>
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

function openAssignment(id){
  const a = data.assignments.find(x=>x.id===id);
  if(!a) return;
  showModal(
    `${a.title}`,
    `
      <div class="item-sub">${formatDate(a.date)}</div>
      <div class="tracker-grid">
        ${[...data.students].sort((x,y)=>x.number-y.number).map(s=>{
          const r = ensureRecord(a.id,s.id);
          return `
            <div class="tracker-tile">
              <div class="tracker-tile-head">
                <span class="student-no">${String(s.number).padStart(2,"0")}</span>
                <span class="student-name">${escapeHtml(s.name)}</span>
              </div>
              <select class="status-select ${r.status}" onchange="setStatus('${a.id}','${s.id}',this)">
                ${STATUS_ORDER.map(status => `<option value="${status}" ${r.status===status ? "selected" : ""}>${STATUS_LABEL[status]}</option>`).join("")}
              </select>
              <input class="note-input" placeholder="備註" value="${escapeAttr(r.note||"")}"
                onchange="updateNote('${a.id}','${s.id}',this.value)" />
            </div>
          `;
        }).join("")}
      </div>
      <div class="modal-actions">
        <button class="secondary" onclick="deleteAssignment('${a.id}')">刪除作業</button>
        <button class="primary" onclick="closeModal()">完成</button>
      </div>
    `
  );
  persistActiveClass();
}

function setStatus(assignmentId, studentId, select){
  const r = ensureRecord(assignmentId, studentId);
  r.status = select.value;
  persistActiveClass();
  select.className = `status-select ${r.status}`;
  renderDashboard();
  renderAssignments();
  renderStudents();
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
    renderAll();
    toast("作業已完成，已從總覽移除 🎉");
  }
}

function updateNote(assignmentId, studentId, note){
  const r = ensureRecord(assignmentId, studentId);
  r.note = note.trim();
  persistActiveClass();
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
  renderAll();
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
document.querySelectorAll("[data-sensitivity]").forEach(btn=>btn.addEventListener("click",()=>{
  const input=noiseEl("noiseSensitivity");
  if(input){input.value=btn.dataset.sensitivity;renderNoiseTool()}
}));


renderClassHome();

startDateRolloverGuards();

