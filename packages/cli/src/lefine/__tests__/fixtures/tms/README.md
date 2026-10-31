# Export fixtures for `lefine import`

Crowdin, Lokalise, Phrase and Transifex: **not verbatim vendor exports.** No vendor publishes real export files we
could find (checked 2026-10-30: their docs and their GitHub orgs; Transifex's parser fixtures in transifex/openformats
are GPL-3.0, so they are not copied here). Each file is shaped after the vendor's official docs, with our own values.
POEditor: **real exports**, excerpted, credited below. When a doc changes, compare it with these files.

| File | Shaped after |
|---|---|
| `crowdin/zip/*/common.json` | Crowdin i18next JSON, https://support.crowdin.com/file-formats/i18next-json/ ; the zip has a folder per language, https://support.crowdin.com/downloading-translations/ . No review state. |
| `crowdin/de-DE.xlf` | Crowdin XLIFF 1.2, https://support.crowdin.com/file-formats/xliff/ : numeric `trans-unit` ids, so `lefine import` refuses it. |
| `lokalise/de.json` | Lokalise nested JSON, https://docs.lokalise.com/en/articles/1400773-json-nested-json , plural `json_string` format. No review state. |
| `lokalise/de.structured.json` | Lokalise structured JSON, https://docs.lokalise.com/en/articles/3229161-structured-json ; `::` nests. No review state. |
| `lokalise/de.xliff` | Lokalise XLIFF 1.2, https://docs.lokalise.com/en/articles/1400816-xliff-xlf-xliff ; the `state` values are the ones its import table reads (its export of `state` is not documented). |
| `phrase/strings.json` | Phrase Strings JSON, https://support.phrase.com/hc/en-us/articles/20038313421468 ; `state` per translation. |
| `phrase/de.json`, `phrase/nested/de.json` | Phrase simple and nested JSON, https://support.phrase.com/hc/en-us/articles/6111346248860 and .../6111330881692 . No review state. |
| `phrase/en-GB.xlf` | Phrase XLIFF 1.2 with `include_translation_state`, https://support.phrase.com/hc/en-us/articles/6111346587292 . |
| `transifex/de.json` | Transifex key-value JSON with ICU plurals, https://help.transifex.com/en/articles/6220806-downloading-translations . No review state. |
| `transifex/structured/de.json` | Transifex structured JSON, https://help.transifex.com/en/articles/6220899-structured-json : `string`, `context`, `developer_comment`, `character_limit`. No review state. |
| `transifex/de.xlf` | Transifex XLIFF 1.2, https://help.transifex.com/en/articles/6222996-xliff : `approved="yes"` or `"no"`, a plural group `trial[0]`/`trial[1]`. |
| `transifex/xliff2/de.xlf` | Transifex XLIFF 2.0, https://help.transifex.com/en/articles/16942119-xliff-2-0 : `srcLang` only, no state; the language comes from the folder or file name. |
| `transifex/de.po` | Transifex PO, https://help.transifex.com/en/articles/6220794-gettext-po ; its `Language:` header says `en` on purpose (seen in Transifex's own fixtures): the file name wins. |
| `poeditor/fr.json` | POEditor `json` export as kept by NijiDigital/poesie, `spec/fixtures/terms.json` @72d6659e (Apache-2.0). |
| `poeditor/pl.po`, `poeditor/ja.po` | Real POEditor exports (header `X-Generator: POEditor.com`), excerpted from xou816/spot `po/pl.po` and `po/ja.po` @21ee601f. MIT License, Copyright (c) 2020 Alexandre Trendel. `ja.po` keeps a `#, fuzzy` entry; `pl.po` a four-form plural with an empty form. |
