#!/usr/bin/env python3
"""LibreOffice 代理測試（不等同 Microsoft Excel 實機驗收）。

用法：python3 tests/xlsx-recalc-libreoffice.py <匯出的完整班級.xlsx> <輸出資料夾>
- 以無頭 LibreOffice（UNO）開啟檔案，確認工作表、篩選、標題合併、凍結窗格與平均公式存在；
- 重新計算後比對第一張工作表每位學生的平均；
- 修改一個分數後重新計算，確認平均改變為預期值；
- 另存為 .xlsx 後重新開啟，確認公式與新值保留。
結束代碼 0 = 全部通過。需要系統已安裝 LibreOffice 與 python3-uno。
"""
import os, subprocess, sys, time, shutil, tempfile, json

import uno
from com.sun.star.beans import PropertyValue

SRC, OUT = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
os.makedirs(OUT, exist_ok=True)
results = []
def check(name, ok, detail=None):
    results.append(ok)
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or detail is None else "\n      " + json.dumps(detail, ensure_ascii=False)))

def prop(name, value):
    p = PropertyValue(); p.Name = name; p.Value = value; return p

profile = tempfile.mkdtemp(prefix="lo-profile-")
port = 2002 + os.getpid() % 1000
proc = subprocess.Popen(["soffice", "--headless", "--invisible", "--nologo", "--norestore", "--nodefault",
                         f"-env:UserInstallation=file://{profile}", f"--accept=socket,host=127.0.0.1,port={port};urp;"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
    ctx = None
    for _ in range(60):
        try:
            ctx = resolver.resolve(f"uno:socket,host=127.0.0.1,port={port};urp;StarOffice.ComponentContext"); break
        except Exception:
            time.sleep(0.5)
    desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
    def load(path):
        # LibreOffice 剛啟動時可能尚未就緒而回傳 None：重試；並以 ASCII 暫存路徑開啟。
        work = os.path.join(profile, f"in-{len(os.listdir(profile))}.xlsx"); shutil.copyfile(path, work)
        for _ in range(40):
            d = desktop.loadComponentFromURL(uno.systemPathToFileUrl(work), "_blank", 0, (prop("Hidden", True),))
            if d is not None: return d
            time.sleep(0.5)
        raise RuntimeError("LibreOffice 無法開啟檔案：" + path)

    doc = load(SRC)
    names = list(doc.Sheets.ElementNames)
    check("工作表可開啟並保留名稱", len(names) >= 3 and names[0] in ("全部成績", "目前畫面"), names)
    sh = doc.Sheets.getByIndex(0)
    cursor = sh.createCursor(); cursor.gotoEndOfUsedArea(False)
    last_col, last_row = cursor.RangeAddress.EndColumn, cursor.RangeAddress.EndRow   # 0-based
    # 標題合併
    title = sh.getCellRangeByPosition(0, 0, last_col, 0); sub = sh.getCellRangeByPosition(0, 1, last_col, 1)
    check("第 1、2 列標題為合併儲存格", title.getIsMerged() and sub.getIsMerged())
    # 篩選：LibreOffice 把 <autoFilter> 匯入為工作表的匿名資料庫範圍（UnnamedDatabaseRanges）
    ur = doc.getPropertyValue("UnnamedDatabaseRanges")
    filt = ur.getByTable(0) if ur.hasByTable(0) else None
    area = filt.DataArea if filt else None
    check("第一張工作表保留自動篩選，範圍自第 4 列標題起涵蓋全部資料列",
          bool(filt and filt.AutoFilter and area.StartRow == 3 and area.StartColumn == 0 and area.EndColumn == last_col and area.EndRow == max(3, last_row)),
          {"autoFilter": bool(filt and filt.AutoFilter), "area": [area.StartColumn, area.StartRow, area.EndColumn, area.EndRow] if area else None, "used": [last_col, last_row]})
    # 凍結窗格
    view = doc.CurrentController
    view.setActiveSheet(sh)
    check("凍結窗格保留", view.hasFrozenPanes())
    # 平均公式：最後一欄、第 5 列起
    avg_col = last_col
    header_last = sh.getCellByPosition(avg_col, 3).String
    check("最後一欄為「平均（百分制）」", header_last.startswith("平均"), header_last)
    doc.calculateAll()
    formulas, mismatch = 0, []
    student_rows = []
    for r in range(4, last_row + 1):
        c = sh.getCellByPosition(avg_col, r)
        if c.Formula.startswith("="):
            formulas += 1
            # 依匯出規則重算：已登記分數 ÷ 滿分 × 100 的等權平均，ROUND 1
            vals = []
            for col in range(2, avg_col):
                hdr = sh.getCellByPosition(col, 3).String
                cell = sh.getCellByPosition(col, r)
                import re
                m = re.search(r"滿分 ([0-9.]+)）$", hdr)
                if m and cell.Type.value == "VALUE":
                    vals.append(cell.Value / float(m.group(1)) * 100)
            expect = round(sum(vals) / len(vals) + 1e-12, 1) if vals else None
            got = c.Value if c.Type.value == "FORMULA" and c.String != "" else None
            student_rows.append(r)
            if (expect is None and got is not None) or (expect is not None and (got is None or abs(got - expect) > 1e-9)):
                mismatch.append({"row": r + 1, "expect": expect, "got": got, "formula": c.Formula[:80]})
    check(f"平均欄為公式（{formulas} 列），重新計算結果與匯出規則一致", formulas > 0 and not mismatch, mismatch)
    # 修改一個分數後重算
    r0 = student_rows[0]
    target = sh.getCellByPosition(2, r0)
    hdr = sh.getCellByPosition(2, 3).String
    import re
    mx = float(re.search(r"滿分 ([0-9.]+)）$", hdr).group(1))
    before = sh.getCellByPosition(avg_col, r0).Value
    # 改成 50%；若原值已是 50%，改成 25%，確保真的改變了分數
    new_value = mx * 0.25 if target.Type.value == "VALUE" and abs(target.Value - mx * 0.5) < 1e-9 else mx * 0.5
    target.Value = new_value
    doc.calculateAll()
    vals = []
    for col in range(2, avg_col):
        h = sh.getCellByPosition(col, 3).String; cell = sh.getCellByPosition(col, r0)
        m = re.search(r"滿分 ([0-9.]+)）$", h)
        if m and cell.Type.value == "VALUE": vals.append(cell.Value / float(m.group(1)) * 100)
    expect = round(sum(vals) / len(vals) + 1e-12, 1)
    after = sh.getCellByPosition(avg_col, r0).Value
    check("修改測試分數後平均重新計算為預期值", abs(after - expect) < 1e-9 and after != before, {"before": before, "after": after, "expect": expect})
    # 另存 xlsx 後重新開啟
    saved = os.path.join(OUT, "libreoffice-修改後另存.xlsx")
    doc.storeToURL(uno.systemPathToFileUrl(saved), (prop("FilterName", "Calc MS Excel 2007 XML"),))
    doc.close(True)
    doc2 = load(saved); sh2 = doc2.Sheets.getByIndex(0); doc2.calculateAll()
    c2 = sh2.getCellByPosition(avg_col, r0)
    check("另存後重新開啟：公式仍在、值保留", c2.Formula.startswith("=") and abs(c2.Value - expect) < 1e-9, {"formula": c2.Formula[:60], "value": c2.Value})
    check("另存後重新開啟：修改的分數保留", abs(sh2.getCellByPosition(2, r0).Value - new_value) < 1e-9)
    doc2.close(True)
finally:
    proc.terminate()
    try: proc.wait(10)
    except Exception: proc.kill()
    shutil.rmtree(profile, ignore_errors=True)

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
