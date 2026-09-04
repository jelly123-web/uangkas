$ErrorActionPreference = "Stop"

$sourcePath = "C:\Users\HP\OneDrive\Dokumen\TUGAS SEMUA PELAJARAN\pak if\kls 12\blok 2\laporan uangkas.docx"
$targetPath = "C:\Users\HP\OneDrive\Dokumen\TUGAS SEMUA PELAJARAN\pak if\kls 12\blok 2\laporan uangkas-format-halaman-final-3.docx"

$wdSectionBreakNextPage = 2
$wdHeaderFooterPrimary = 1
$wdHeaderFooterFirstPage = 2
$wdPageNumberStyleArabic = 0
$wdPageNumberStyleLowercaseRoman = 2
$wdAlignParagraphCenter = 1
$wdAlignParagraphRight = 2
$wdGoToPage = 1
$wdGoToAbsolute = 1
$wdGoToNext = 2
$wdFieldPage = 33

function Clear-HF($hf) {
    $hf.LinkToPrevious = $false
    $hf.Range.Text = ""
}

function Add-PageNumberFieldToHF($hf, [int]$alignment) {
    $hf.LinkToPrevious = $false
    $hf.Range.Text = ""
    $hf.Range.ParagraphFormat.Alignment = $alignment
    $collapsed = $hf.Range.Duplicate
    $collapsed.Collapse(1)
    $null = $hf.Range.Document.Fields.Add($collapsed, $wdFieldPage)
}

function Insert-SectionBreakAtPageStart($document, [int]$pageNumber) {
    $selection = $document.Application.Selection
    $range = $document.GoTo($wdGoToPage, $wdGoToAbsolute, $pageNumber)
    $selection.SetRange($range.Start, $range.Start)
    $selection.Collapse(1)
    $selection.InsertBreak($wdSectionBreakNextPage)
}

if (!(Test-Path -LiteralPath $sourcePath)) {
    throw "File sumber tidak ditemukan: $sourcePath"
}

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0

try {
    $document = $word.Documents.Open($sourcePath, $false, $false, $false)
    $document.SaveAs([ref]$targetPath)

    $breakPages = @(33, 14, 11, 9, 7, 2)
    foreach ($page in $breakPages) {
        Insert-SectionBreakAtPageStart $document $page
    }

    if ($document.Sections.Count -lt 3) {
        throw "Section break belum berhasil dibuat. Section saat ini: $($document.Sections.Count)"
    }

    foreach ($section in $document.Sections) {
        $section.PageSetup.DifferentFirstPageHeaderFooter = $false
        $section.PageSetup.OddAndEvenPagesHeaderFooter = $false
        foreach ($idx in @($wdHeaderFooterPrimary, $wdHeaderFooterFirstPage)) {
            Clear-HF $section.Headers.Item($idx)
            Clear-HF $section.Footers.Item($idx)
        }
    }

    $cover = $document.Sections.Item(1)
    $cover.PageSetup.DifferentFirstPageHeaderFooter = $true
    Clear-HF $cover.Headers.Item($wdHeaderFooterPrimary)
    Clear-HF $cover.Headers.Item($wdHeaderFooterFirstPage)
    Clear-HF $cover.Footers.Item($wdHeaderFooterPrimary)
    Clear-HF $cover.Footers.Item($wdHeaderFooterFirstPage)

    $frontMatter = $document.Sections.Item(2)
    $frontMatter.PageSetup.DifferentFirstPageHeaderFooter = $false
    Add-PageNumberFieldToHF $frontMatter.Footers.Item($wdHeaderFooterPrimary) $wdAlignParagraphCenter
    $frontMatter.Footers.Item($wdHeaderFooterPrimary).PageNumbers.RestartNumberingAtSection = $true
    $frontMatter.Footers.Item($wdHeaderFooterPrimary).PageNumbers.StartingNumber = 1
    $frontMatter.Footers.Item($wdHeaderFooterPrimary).PageNumbers.NumberStyle = $wdPageNumberStyleLowercaseRoman

    for ($i = 3; $i -le $document.Sections.Count; $i++) {
        $section = $document.Sections.Item($i)
        $section.PageSetup.DifferentFirstPageHeaderFooter = $true

        $firstFooter = $section.Footers.Item($wdHeaderFooterFirstPage)
        $primaryHeader = $section.Headers.Item($wdHeaderFooterPrimary)
        $primaryFooter = $section.Footers.Item($wdHeaderFooterPrimary)
        $firstHeader = $section.Headers.Item($wdHeaderFooterFirstPage)

        Add-PageNumberFieldToHF $firstFooter $wdAlignParagraphCenter
        Add-PageNumberFieldToHF $primaryHeader $wdAlignParagraphRight
        Clear-HF $primaryFooter
        Clear-HF $firstHeader

        if ($i -eq 3) {
            $firstFooter.PageNumbers.RestartNumberingAtSection = $true
            $firstFooter.PageNumbers.StartingNumber = 1
        } else {
            $firstFooter.PageNumbers.RestartNumberingAtSection = $false
        }

        $firstFooter.PageNumbers.NumberStyle = $wdPageNumberStyleArabic
        $primaryHeader.PageNumbers.NumberStyle = $wdPageNumberStyleArabic
    }

    foreach ($toc in $document.TablesOfContents) {
        $toc.Update() | Out-Null
    }

    $document.Fields.Update() | Out-Null
    $document.Repaginate()
    $document.Save()
    $document.Close()
}
finally {
    if ($document) {
        try { $document.Close([ref]0) } catch {}
    }
    if ($word) {
        try { $word.Quit() } catch {}
    }
}
