const APP_VERSION = "2.3";

const STORAGE_KEY = "homeworkTrackerDataV1";

const STATUS_ORDER = ["pending","submitted","correction","completed","missing"];
const STATUS_LABEL = {
  pending:"未確認",
  submitted:"已交",
  correction:"待訂正",
  completed:"完成",
  missing:"缺交"
};

let data = loadData();
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
    contactItems:[]
  };
}

function loadData(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return defaultData();
    const parsed = JSON.parse(raw);
    return normalizeData(parsed);
  }catch(e){
    console.error(e);
    return defaultData();
  }
}

function normalizeData(input){
  const base = defaultData();
  return {
    version:1,
    class:{name: input?.class?.name || ""},
    students:Array.isArray(input?.students) ? input.students : [],
    assignments:Array.isArray(input?.assignments) ? input.assignments.map(a => ({...a, dashboardArchived: Boolean(a.dashboardArchived), createdAt: a.createdAt || `${a.date || ""}T00:00:00.000Z`})) : [],
    records:Array.isArray(input?.records) ? input.records : [],
    contactItems:Array.isArray(input?.contactItems) ? input.contactItems.map(i => ({
      ...i,
      trackAsAssignment:Boolean(i.trackAsAssignment),
      createdAt:i.createdAt || `${i.date || ""}T00:00:00.000Z`
    })) : []
  };
}

function saveData(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  renderAll();
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

function setPage(page){
  currentPage = page;
  document.querySelectorAll(".page").forEach(el=>el.classList.toggle("active", el.id===page));
  document.querySelectorAll(".tab").forEach(el=>el.classList.toggle("active", el.dataset.page===page));
  renderAll();
}

function renderAll(){
  document.getElementById("todayText").textContent = formatToday();
  const className = data.class.name || "尚未設定班級";
  document.getElementById("headerClassName").textContent = data.class.name || "學生作業追蹤";
  document.getElementById("dashboardClassName").textContent = className;
  document.getElementById("classNameInput").value = data.class.name || "";
  renderDashboard();
  renderAssignments();
  renderContactBook();
  renderStudents();
  renderSettingsRoster();
}

function renderDashboard(){
  const missing = data.records.filter(r=>r.status==="missing");
  const correction = data.records.filter(r=>r.status==="correction");
  const completed = data.records.filter(r=>r.status==="completed");

  document.getElementById("missingCount").textContent = missing.length;
  document.getElementById("missingPeople").textContent = `${new Set(missing.map(r=>r.studentId)).size} 人`;
  document.getElementById("correctionCount").textContent = correction.length;
  document.getElementById("correctionPeople").textContent = `${new Set(correction.map(r=>r.studentId)).size} 人`;
  document.getElementById("completedCount").textContent = completed.length;

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
    .filter(x=>x.student && x.assignment && !x.assignment.dashboardArchived)
    .sort((a,b)=> b.assignment.date.localeCompare(a.assignment.date));

  if(!pendingRecords.length){
    pendingList.innerHTML = `<div class="empty">目前沒有缺交或待訂正的學生。</div>`;
  }else{
    pendingList.innerHTML = pendingRecords.map(x=>`
      <div class="item-card clickable" onclick="openAssignment('${x.assignment.id}')">
        <div class="item-main">
          <div class="item-title">${escapeHtml(String(x.student.number).padStart(2,"0"))} ${escapeHtml(x.student.name)}</div>
          <div class="item-sub">${formatDate(x.assignment.date)}｜${escapeHtml(x.assignment.subject || "未分類")}｜${escapeHtml(x.assignment.title)}${x.note ? `｜${escapeHtml(x.note)}`:""}</div>
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
          <div class="item-sub">${formatDate(a.date)}｜${escapeHtml(a.subject || "未分類")}</div>
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
        <div class="item-sub">${formatDate(a.date)}｜${escapeHtml(a.subject || "未分類")}</div>
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

function openNewContactItem(){
  showModal(
    "新增聯絡事項",
    `
      <form id="newContactItemForm" class="modal-form">
        <label><span>日期</span><input type="date" id="contactNewDate" value="${localDateString()}" required></label>
        <label><span>事項</span><input id="contactNewTitle" placeholder="例如：數學習作 P.42、明天帶水壺" required></label>
        <label><span>補充說明</span><textarea id="contactNewNote" rows="3" placeholder="選填"></textarea></label>
        <label class="check-row">
          <input type="checkbox" id="contactTrackAssignment">
          <span>同時登錄到作業追蹤</span>
        </label>
        <label id="contactSubjectWrap" class="hidden-field"><span>作業科目</span><input id="contactNewSubject" placeholder="例如：數學"></label>
        <div class="modal-actions">
          <button type="button" class="secondary" onclick="closeModal()">取消</button>
          <button class="primary" type="submit">新增</button>
        </div>
      </form>
    `
  );

  const check = document.getElementById("contactTrackAssignment");
  const subjectWrap = document.getElementById("contactSubjectWrap");
  check.addEventListener("change",()=>subjectWrap.classList.toggle("hidden-field", !check.checked));

  document.getElementById("newContactItemForm").addEventListener("submit", e=>{
    e.preventDefault();
    const item = {
      id:uid("c"),
      date:document.getElementById("contactNewDate").value,
      title:document.getElementById("contactNewTitle").value.trim(),
      note:document.getElementById("contactNewNote").value.trim(),
      subject:document.getElementById("contactNewSubject").value.trim(),
      trackAsAssignment:check.checked,
      assignmentId:null,
      createdAt:new Date().toISOString()
    };
    if(item.trackAsAssignment){
      const assignment = createAssignmentFromContact(item);
      item.assignmentId = assignment.id;
    }
    data.contactItems.push(item);
    saveData();
    closeModal();
    toast(item.trackAsAssignment ? "聯絡事項已新增，並同步到作業" : "聯絡事項已新增");
  });
}

function createAssignmentFromContact(item){
  const assignment = {
    id:uid("a"),
    date:item.date,
    subject:item.subject || "聯絡簿",
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

function renderStudents(){
  const q = document.getElementById("studentSearch").value.trim().toLowerCase();
  let students = [...data.students].sort((a,b)=>a.number-b.number);
  if(q){
    students = students.filter(s=>String(s.number).includes(q) || s.name.toLowerCase().includes(q));
  }
  const list = document.getElementById("studentList");
  if(!students.length){
    list.innerHTML = `<div class="empty">尚未建立學生名單，請到「設定」加入學生。</div>`;
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
  if(document.activeElement !== ta) ta.value = text;
}

function openAssignment(id){
  const a = data.assignments.find(x=>x.id===id);
  if(!a) return;
  showModal(
    `${a.title}`,
    `
      <div class="item-sub">${formatDate(a.date)}｜${escapeHtml(a.subject || "未分類")}</div>
      <div class="tracker-grid">
        ${[...data.students].sort((x,y)=>x.number-y.number).map(s=>{
          const r = ensureRecord(a.id,s.id);
          return `
            <div class="tracker-tile">
              <div class="tracker-tile-head">
                <span class="student-no">${String(s.number).padStart(2,"0")}</span>
                <span class="student-name">${escapeHtml(s.name)}</span>
              </div>
              <button class="status-btn ${r.status}" onclick="cycleStatus('${a.id}','${s.id}',this)">
                ${STATUS_LABEL[r.status]}
              </button>
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function cycleStatus(assignmentId, studentId, button){
  const r = ensureRecord(assignmentId, studentId);
  const idx = STATUS_ORDER.indexOf(r.status);
  r.status = STATUS_ORDER[(idx+1)%STATUS_ORDER.length];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  button.className = `status-btn ${r.status}`;
  button.textContent = STATUS_LABEL[r.status];
  renderDashboard();
  renderAssignments();
  renderContactBook();
  renderStudents();
  maybeArchiveCompletedAssignment(assignmentId);
}

function maybeArchiveCompletedAssignment(assignmentId){
  const a = data.assignments.find(x=>x.id===assignmentId);
  if(!a || a.dashboardArchived || !data.students.length) return;
  const {percent} = assignmentProgress(assignmentId);
  if(percent !== 100) return;
  const shouldArchive = confirm(`「${a.title}」完成率已達 100%！\n\n是否從總覽的待處理作業清單移除？\n（作業與學生歷史紀錄仍會保留）`);
  if(shouldArchive){
    a.dashboardArchived = true;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    renderAll();
    toast("作業已完成，已從總覽移除 🎉");
  }
}

function updateNote(assignmentId, studentId, note){
  const r = ensureRecord(assignmentId, studentId);
  r.note = note.trim();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
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
              <div class="item-sub">${formatDate(x.a.date)}｜${escapeHtml(x.a.subject||"未分類")}${x.r.note?`｜${escapeHtml(x.r.note)}`:""}</div>
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
    toast("請先到設定建立學生名單");
    setPage("settings");
    return;
  }
  showModal(
    "新增作業",
    `
      <form id="newAssignmentForm" class="modal-form">
        <label><span>日期</span><input type="date" id="newDate" value="${localDateString()}" required></label>
        <label><span>科目</span><input id="newSubject" placeholder="例如：數學"></label>
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
      subject:document.getElementById("newSubject").value.trim(),
      title:document.getElementById("newTitle").value.trim(),
      createdAt:new Date().toISOString(),
      dashboardArchived:false
    };
    data.assignments.push(assignment);
    data.students.forEach(s=>{
      data.records.push({assignmentId:assignment.id, studentId:s.id, status:"pending", note:""});
    });
    saveData();
    closeModal();
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
  const first = confirm("這會清除目前瀏覽器中的所有班級、學生與作業紀錄。要繼續嗎？");
  if(!first) return;
  const second = confirm("再次確認：清除後若沒有備份，資料無法復原。");
  if(!second) return;
  localStorage.removeItem(STORAGE_KEY);
  data = defaultData();
  saveData();
  toast("所有資料已清除");
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
document.getElementById("dashboardAddAssignment").addEventListener("click",openNewAssignment);
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

renderAll();
