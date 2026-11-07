# Aetherbound

Aetherbound 是面向 Windows 的本地 TXT / EPUB 阅读器。它提供书库、珍藏、文件夹扫描、阅读进度、书签、摘录、笔记、书内搜索和 EPUB 图片目录。阅读界面与书库界面分开，书库使用夜空、银蓝色文字和蝴蝶动效。

## 安装

在 [GitHub Releases](https://github.com/xuyouquan856-beep/Aetherbound/releases) 下载 `Aetherbound-Setup-*-x64.exe`，运行安装程序。ZIP 是可解压运行的备用版本。首次公开版本需要手动下载安装更新；目前没有自动更新功能。

安装程序只包含应用程序，不包含小说文件或个人书库。默认数据库与 EPUB 阅读缓存位于当前用户的 `%APPDATA%\Aetherbound`。原始 TXT / EPUB 文件仍保存在你选择的文件夹中；移除书目时，只有明确选择“同时删除原始文件”才会尝试把原文件移入系统回收站。卸载程序不会删除用户数据。

已有书库的用户应先关闭旧版，再安装新版。升级前建议备份 `%APPDATA%\Aetherbound` 和原始书籍文件夹；如果用户目录被链接到别的磁盘，也要保留链接目标。开发或测试时可通过 `READER_DATA_ROOT` 指定独立的数据目录。

## 开发与验证

需要 Node.js 22、pnpm 10 和 Windows x64。

```powershell
pnpm install --frozen-lockfile
pnpm dev
pnpm verify
pnpm package:win
```

`pnpm package:win` 生成完整的 NSIS 安装程序和 ZIP，输出到 `release/distribution/`。`pnpm package:dir` 只生成可运行的解压目录。打包结果、测试数据、个人书库和设计阶段使用的真实书籍封面均不进入源码仓库。

发布检查见 [docs/release-checklist.md](docs/release-checklist.md)。

## 数据与权限

应用在本机处理书籍，默认不上传书籍内容，也不包含账户或遥测。外部网页仅在用户主动打开语句出处链接时交给系统浏览器。渲染界面没有 Node.js 文件系统权限；EPUB 阅读内容与应用界面隔离。详细实现可查看 `src/main`、`src/backend`、`src/formats` 和 `src/renderer`。

## 许可证

源码与本仓库中的原创素材按 [MIT License](LICENSE) 发布。用户自行导入的书籍与封面不属于本仓库。
