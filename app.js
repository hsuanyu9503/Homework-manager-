const APP_VERSION = "3.7";

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
        <div class="item-sub">${d.students.length} 位學生｜${d.assignments.length} 項作業</div>
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
      <label><span>班級名稱</span><input id="newClassName" placeholder="例如：五年甲班" required></label>
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

      <label>
        <span>總覽「需留意學生」顯示門檻</span>
        <div class="threshold-input-row">
          <input id="overdueDaysInput" type="number" min="0" step="1" value="${d.settings?.overdueDays ?? 2}" required>
          <span>天</span>
        </div>
        <div class="item-sub">作業日期超過此天數仍未完成，才會顯示在總覽的需留意學生清單。</div>
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
    d.settings = d.settings || {};
    d.settings.overdueDays = Math.max(0, Number(document.getElementById("overdueDaysInput").value) || 0);
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

function renderAll(){
  document.getElementById("todayText").textContent = formatToday();
  const className = data.class.name || "尚未設定班級";
  document.getElementById("headerClassName").textContent = data.class.name || "Classroom Manager";
  document.getElementById("dashboardClassName").textContent = className;
  renderDashboard();
  renderTodayNotices();
  renderAssignments();
  renderContactBook();
  renderStudents();
  renderScores();
  renderGroupScores();
}


function renderTodayNotices(){
  const area=document.getElementById("todayNoticeArea");
  if(!area) return;
  const today=localDateString();
  const notices=[...(Array.isArray(data.notices) ? data.notices : [])]
    .filter(n=>n.date===today && String(n.text || "").trim())
    .sort((a,b)=>(a.createdAt || "").localeCompare(b.createdAt || ""));

  if(!notices.length){
    area.innerHTML=`<div class="today-notice-empty">今日無公告</div>`;
    return;
  }

  area.innerHTML=`
    <div class="today-notice-title">今日公告</div>
    <div class="today-notice-list">
      ${notices.map(n=>`<div class="today-notice-item">${escapeHtml(n.text)}</div>`).join("")}
    </div>
  `;
}

function openNoticeMemo(){
  const notices=[...(data.notices || [])]
    .sort((a,b)=> b.date.localeCompare(a.date) || (b.createdAt || "").localeCompare(a.createdAt || ""));

  const rows=notices.length
    ? notices.map(n=>`
        <div class="notice-memo-row">
          <div class="notice-memo-date">${formatDate(n.date)}</div>
          <div class="notice-memo-text">${escapeHtml(n.text)}</div>
          <div class="notice-memo-actions">
            <button class="secondary small-btn" type="button" onclick="editNotice('${n.id}')">編輯</button>
            <button class="ghost-danger small-btn" type="button" onclick="deleteNotice('${n.id}')">刪除</button>
          </div>
        </div>
      `).join("")
    : `<div class="empty">目前還沒有公告備忘。</div>`;

  showModal("公告備忘錄",`
    <div class="modal-form">
      <form id="newNoticeForm" class="notice-new-form">
        <label>
          <span>顯示日期</span>
          <input type="date" id="noticeDate" value="${localDateString()}" required>
        </label>
        <label class="grow">
          <span>注意事項</span>
          <input id="noticeText" placeholder="例如：記得帶美勞用品" required>
        </label>
        <button class="primary" type="submit">新增</button>
      </form>
      <div class="settings-divider"></div>
      <div class="notice-memo-list">${rows}</div>
    </div>
  `);

  document.getElementById("newNoticeForm").addEventListener("submit",e=>{
    e.preventDefault();
    const date=document.getElementById("noticeDate").value;
    const text=document.getElementById("noticeText").value.trim();
    if(!text) return;
    if(!Array.isArray(data.notices)) data.notices=[];
    data.notices.push({
      id:uid("n"),
      date,
      text,
      createdAt:new Date().toISOString()
    });
    saveData();
    closeModal();
    renderTodayNotices();
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
    notice.date=document.getElementById("editNoticeDate").value;
    notice.text=document.getElementById("editNoticeText").value.trim();
    saveData();
    closeModal();
    renderTodayNotices();
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

  const activeAssignments = [...data.assignments]
    .filter(a=>!a.dashboardArchived)
    .sort((a,b)=> b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const target = document.getElementById("recentAssignments");
  if(!activeAssignments.length){
    target.innerHTML = `<div class="empty cheerful">🎉 目前沒有需要追蹤的作業，全部處理完畢！</div>`;
  }else{
    target.innerHTML = activeAssignments.map(a=>dashboardAssignmentHtml(a)).join("");
  }

  const pendingList = document.getElementById("pendingList");
  const pendingRecords = data.records
    .filter(r=>["missing","correction"].includes(r.status))
    .map(r=>({
      ...r,
      student:data.students.find(s=>s.id===r.studentId),
      assignment:data.assignments.find(a=>a.id===r.assignmentId)
    }))
    .filter(x=>
      x.student &&
      x.assignment &&
      !x.assignment.dashboardArchived &&
      daysSinceDate(x.assignment.date) > overdueThresholdDays()
    )
    .sort((a,b)=> b.assignment.date.localeCompare(a.assignment.date));

  if(!pendingRecords.length){
    pendingList.innerHTML = `<div class="empty">目前沒有超過 ${overdueThresholdDays()} 天仍未完成、需要留意的學生。</div>`;
  }else{
    pendingList.innerHTML = pendingRecords.map(x=>`
      <div class="item-card clickable" onclick="openAssignment('${x.assignment.id}')">
        <div class="item-main">
          <div class="item-title">${escapeHtml(String(x.student.number).padStart(2,"0"))} ${escapeHtml(x.student.name)}</div>
          <div class="item-sub">${formatDate(x.assignment.date)}｜${escapeHtml(x.assignment.title)}${x.note ? `｜${escapeHtml(x.note)}`:""}</div>
        </div>
        <span class="badge ${x.status}">${STATUS_LABEL[x.status]}</span>
      </div>
    `).join("");
  }
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
  if(mode==="group") renderGroupScores();
}

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
    .filter(x=>x.r)
    .sort((x,y)=>y.a.date.localeCompare(x.a.date));
  showModal(
    `${String(s.number).padStart(2,"0")} ${s.name}`,
    `
      <div class="assignment-summary">
        <span class="badge missing">缺交 ${history.filter(x=>x.r.status==="missing").length}</span>
        <span class="badge correction">待訂正 ${history.filter(x=>x.r.status==="correction").length}</span>
        <span class="badge completed">完成 ${history.filter(x=>x.r.status==="completed").length}</span>
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

document.querySelectorAll(".tab").forEach(btn=>btn.addEventListener("click",()=>setPage(btn.dataset.page)));
document.getElementById("quickAddBtn").addEventListener("click",openNewAssignment);
document.getElementById("addClassBtn").addEventListener("click",openAddClass);
document.getElementById("classDataBtn").addEventListener("click",openClassDataPanel);
document.getElementById("backToClassHome").addEventListener("click",leaveClass);
document.getElementById("dashboardAddAssignment").addEventListener("click",openNewAssignment);
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

renderClassHome();
