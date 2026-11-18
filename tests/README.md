# Classroom Manager v2.103 測試（僅供開發，網站不載入）

把本資料夾 `tests/` 放在網站檔案（`index.html`、`app.js`、`style.css`）的同一層，在網站根目錄執行。全部使用虛構資料。

## 安裝
```bash
npm ci --prefix tests
npx --prefix tests playwright install --with-deps chromium
```
- Open XML SDK 驗證工具需要 .NET SDK 8（例如 Ubuntu：`apt-get install dotnet-sdk-8.0`）。`xlsx-structure.test.js` 會自動建置 `tests/xlsx-validator`；也可先自行建置後以 `XLSX_VALIDATOR=<路徑>` 指定。
- LibreOffice 代理測試需要 LibreOffice 與 python3-uno。

## 執行
```bash
node tests/xlsx-structure.test.js
node tests/grade-bands.test.js
node tests/import-backup.test.js
python3 tests/xlsx-recalc-libreoffice.py <匯出的完整班級.xlsx> <輸出資料夾>
```
| 測試 | 內容 |
|---|---|
| `xlsx-structure.test.js` | 以虛構資料實際下載 8 種情境的 XLSX；每個檔案都必須通過 Open XML SDK 驗證與結構檢查（節點順序、關聯、樣式、儲存格型別、公式與快取值、篩選名稱）。`fixtures/v2.102-full-class-wrong-order.xlsx`（v2.102 以虛構資料產生）必須被判定無效。找不到驗證工具時測試失敗，除非設定 `ALLOW_NO_VALIDATOR=1`。`KEEP_XLSX=<資料夾>` 可保留下載的檔案 |
| `grade-bands.test.js` | 成績級距（v2.102 功能）回歸。`V2101_DIR=<基準網站資料夾>` 可加做與基準版的比對 |
| `import-backup.test.js` | 備份匯入與跨分頁寫入回歸（437 項） |
| `xlsx-recalc-libreoffice.py` | LibreOffice 代理測試：篩選、合併、凍結窗格、修改分數後重算、另存再開。**不等同 Microsoft Excel 實機驗收** |
