# 下載與更新

[English](../en/releases.md) · [繁體中文](releases.md) · [首頁](../../README.zh-TW.md)

Claude 網頁版請[直接下載 alpha.12 技能 ZIP](https://github.com/ChristimCiel/SubsNotes/releases/download/v0.2.0-alpha.12/subsnotes-subscription-review.zip)，或開啟 [alpha.12 版本頁](https://github.com/ChristimCiel/SubsNotes/releases/tag/v0.2.0-alpha.12)。它是已公開的 **pre-release／預覽版**。GitHub 的通用「latest」目前指向較舊的 v0.1.0，該版未包含 Claude 技能。需要其他版本時可查看[全部 Releases](https://github.com/ChristimCiel/SubsNotes/releases)。

## 選擇下載檔

| 檔案 | 用途 |
| --- | --- |
| [`subsnotes-subscription-review.zip`](https://github.com/ChristimCiel/SubsNotes/releases/download/v0.2.0-alpha.12/subsnotes-subscription-review.zip) | 在相容的 Claude 帳號安裝技能；一般網頁使用者從這裡開始。 |
| [`subsnotes-claude.html`](https://github.com/ChristimCiel/SubsNotes/releases/download/v0.2.0-alpha.12/subsnotes-claude.html) | 不含使用者資料的儀表板原始碼，供相容的私人 Claude Artifact 使用；本機開啟不會連接 Gmail 或儲存空間。 |
| [`SubsNotes-Evidence-Reader-0.1.5.mcpb`](https://github.com/ChristimCiel/SubsNotes/releases/download/v0.2.0-alpha.12/SubsNotes-Evidence-Reader-0.1.5.mcpb) | 選用的本機唯讀工具，讀取你選擇的既有帳務資料夾；Claude 網頁版不需要它。 |
| [`SHA256SUMS`](https://github.com/ChristimCiel/SubsNotes/releases/download/v0.2.0-alpha.12/SHA256SUMS) | 比對該版本下載檔的完整性雜湊。 |
| GitHub 原始碼封存檔 | 程式碼，不是已設定好的帳號，也不含你的私人資料。 |

## 保留帳本的更新方式

1. 保留目前權威私人 Artifact 的連結，關閉其他可寫入副本。
2. 下載所選版本的技能，在平台技能設定啟用新版。
3. 對 Claude 說：**「用這個版本更新我既有的私人 SubsNotes 儀表板。保留同一份帳本、所有來源、付款確認、歷史與偏好，不要建立另一個儲存空間。」**
4. 平台應先讀取目前程式與資料版本，使用受支援的版本保護更新方式，再讀回確認。
5. 重開相同連結，查看已儲存紀錄。只安裝技能，不代表既有 Artifact 的程式已更新。

若平台無法安全更新原本的私人 Artifact，請保留帳本並說明缺少的能力。下載的 HTML 不是財務資料備份，也不要為了更新介面，用過期快照取代較新的帳本。

## 檢查下載完整性

若已下載表中三個套件／原始碼檔及 `SHA256SUMS`，請在同一資料夾執行：

```sh
shasum -a 256 -c SHA256SUMS  # macOS
sha256sum -c SHA256SUMS     # Linux
```

若只下載技能 ZIP，macOS 可執行 `shasum -a 256 subsnotes-subscription-review.zip`，Linux 可執行 `sha256sum subsnotes-subscription-review.zip`，再比對 `SHA256SUMS` 的對應項目。

Windows 可在 PowerShell 執行 `Get-FileHash -Algorithm SHA256 .\subsnotes-subscription-review.zip`，再與 `SHA256SUMS` 的對應項目比對。

校驗相符代表下載副本與該版本列出的位元內容一致，不等於每項功能都已驗證、已取得連接權限，或某份本機資料已具有可信來源。

私人備份與匯出放在 repository 之外，勿上傳 Issue 或 Release。詳見[安全與隱私](../../SECURITY.zh-TW.md)。
