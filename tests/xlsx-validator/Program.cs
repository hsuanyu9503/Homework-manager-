// Open XML SDK 驗證：xlsx-validate <file.xlsx> [...]
// 以 Office 2019 結構描述驗證每個部件；任何錯誤都會列出部件、XPath 與說明，並以結束代碼 1 回報。
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;

int failed = 0;
foreach (var path in args)
{
    try
    {
        using var doc = SpreadsheetDocument.Open(path, false);
        var validator = new OpenXmlValidator(FileFormatVersions.Office2019) { MaxNumberOfErrors = 0 };
        var errors = validator.Validate(doc).ToList();
        Console.WriteLine($"{Path.GetFileName(path)}: {(errors.Count == 0 ? "VALID" : $"INVALID ({errors.Count} errors)")}");
        foreach (var e in errors)
            Console.WriteLine($"  [{e.ErrorType}] {e.Part?.Uri} {e.Path?.XPath} :: {e.Description}");
        if (errors.Count > 0) failed++;
    }
    catch (Exception ex)
    {
        Console.WriteLine($"{Path.GetFileName(path)}: OPEN FAILED :: {ex.GetType().Name}: {ex.Message}");
        failed++;
    }
}
return failed == 0 ? 0 : 1;
