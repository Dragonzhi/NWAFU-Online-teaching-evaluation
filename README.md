# NWAFU 网上评教辅助（Tampermonkey 用户脚本）

西北农林科技大学网上评教的浏览器油猴脚本。登录、2FA、扫码和会话都交给浏览器本身；脚本只在**已登录的评教页面**操作 DOM，不接触账号密码。

> 当前版本 v2.2.3。学校评教系统网址已变更，脚本不再绑死旧的 `jwwspj` 地址：匹配 `*.nwafu.edu.cn`，运行时按页面内容识别列表页/问卷页。识别不到时按 `Alt+Shift+P` 强制打开面板，用“自检 / 复制结构”导出页面结构再适配。

### 2026-10 实测

- 新地址：`https://ehall.nwafu.edu.cn/jwapp/sys/jwwspj/*default/index.do...#/gcpj`，`ehall` 已由 `@match` 覆盖。
- 列表卡片：`.bh-card.bh-card-lv1[data-action="查询问卷详情"]`，`data-x-sfpg="0"` 表示未提交；去重使用 `data-x-jxbid` + `data-x-wjdm`。
- 问卷页：`.bh-paper-pile-dialog` 弹窗；8 组隐藏原生 radio 包在 `label.bh-radio-label` 里，选项文字在 `data-x-dasm`；主观题是 `textarea[name="YLCS"]`；提交是 `a[data-action="提交"]`。
- 默认行为已改为全自动：从列表打开每一份未提交问卷、填写、提交，不再弹脚本自己的确认。

## 功能

- 自动识别评教列表页和问卷页（宽匹配，不依赖旧路径）
- 列表页优先用 `.bh-card.bh-card-lv1[data-action="查询问卷详情"]` 和 `data-x-sfpg` 识别未提交项
- 全自动：自动打开下一份未提交问卷、填写、提交，循环到全部完成
- 单份问卷：填写并提交当前问卷
- 按 label/`data-x-dasm` 文本选择“完全赞同”，填写所有空的文本域
- 支持隐藏的原生 radio（通过可见 label 点击）、`[role=radio]` 自定义单选、`textarea` 和 `contenteditable`
- 支持同源 iframe 里的问卷
- 提交后校验表单关闭/成功提示；失败停止并写日志
- 浮动面板：进度、日志、停止、设置、自检、记录导出
- 本地记录（`localStorage`）与 JSON 导出
- 不收集账号密码，不发任何网络请求

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)（Chrome/Edge/Firefox）或 Violentmonkey。Chrome 商店访问不了时，可装 Edge 加载项版，或用开源的 Violentmonkey。
2. 新建用户脚本，把 `nwafu-eval.user.js` 全文粘进去，保存。
3. 或者直接在浏览器里打开 `nwafu-eval.user.js`，Tampermonkey 会弹出安装页。

脚本匹配 `https://newehall.nwafu.edu.cn/*` 和 `https://*.nwafu.edu.cn/*`，排除统一身份认证 `authserver`。如果新评教系统不在 `nwafu.edu.cn` 域名下，在文件头加一行 `@match` 即可。

## 使用

1. 正常登录学校门户，2FA/扫码都由你自己完成。
2. 打开评教列表页。
3. 右下角出现“NWAFU 评教辅助”面板；没有就按 `Alt+Shift+P`。
4. **全自动**：点“全自动：打开并提交”。脚本会自动打开第一份未提交问卷、填写、提交，等待列表刷新后继续下一份，直到全部完成。
5. **单份**：手动打开一份问卷，点“填写并提交当前问卷”。按钮只在问卷页可用，列表页会自动禁用。
6. 页面改版/面板识别不到：点“自检 / 复制结构”，把复制内容发给维护者适配选择器（需要先手动打开问卷页）。

### 设置

- **选项文字**：默认“完全赞同”；找不到时依次尝试“非常赞同/满意/非常满意/优秀”，再退到该组最后一个选项。
- **评语池**：每行一条，随机选择并避免连续重复。
- **选择题间隔**：默认 500ms。
- **每次提交前确认**：默认关闭，直接提交；需要复核时勾上。
- **覆盖已选答案**：默认关，已经选过的题会跳过。
- **单次最多份数**：默认 50。

## 安全与边界

- 脚本不读取、不存储、不发送账号密码；登录完全由浏览器完成。
- 默认全自动提交；想先检查就手动打开一份，点“填写并提交当前问卷”，或勾选“每次提交前确认”。
- 所有设置和历史只存在本机 `localStorage`，可随时清空/导出。
- “自检”输出包含页面文本和 HTML 片段，分享前请自行检查是否含敏感信息。
- 请遵守学校评教规定；第一次使用建议只选一份试运行，确认填写和提交流程无误后再全自动。

## 排错

- **面板不出现**：确认在评教页；按 `Alt+Shift+P`；再用“自检”。
- **未识别到未提交项**：可能不在列表页，或页面结构变了；用自检输出。
- **未找到提交按钮**：可能已提交，或按钮文案变了；用自检看按钮列表。
- **全自动停在提交确认**：看日志里有没有“已点击确认弹窗”。如果没有，提交确认按钮的文案可能不是“确定/确认”；在确认弹窗打开时跑一次自检，把结构发来。
- **批量中途停止**：看面板日志；确保只开一个评教标签页。页面整页刷新后脚本会重新注入，但当前批次会中断。
- **新网址**：`@match` 已放宽到 `*.nwafu.edu.cn`；如果换成其他域名，手动加 `@match`。
- **更新失败**：`raw.githubusercontent.com` 在国内可能不通；脚本已改用 jsDelivr，见下面的“更新”。

## 更新

脚本头已配置 jsDelivr（fastly 节点）的 `@updateURL/@downloadURL`，不再依赖 raw GitHub：

```
https://fastly.jsdelivr.net/gh/Dragonzhi/NWAFU-Online-teaching-evaluation@main/nwafu-eval.user.js
```

首次从 2.2.x 升到 2.2.3，可以用固定 tag 的安装页：

```
https://fastly.jsdelivr.net/gh/Dragonzhi/NWAFU-Online-teaching-evaluation@v2.2.3/nwafu-eval.user.js
```

在浏览器打开上面的链接，Tampermonkey 会弹出安装/更新页，点“更新”即可。之后自动更新会走 `@main`；jsDelivr 对分支有缓存，刚发布的版本可能要等几分钟到几小时。fastly 节点也不通时，可以试 `gcore.jsdelivr.net`，或者直接用本地 `nwafu-eval.user.js` 覆盖。

## 开发与测试

```powershell
# 语法检查
node --check nwafu-eval.user.js

# 本地 demo
python -m http.server 8765
# 浏览器打开 http://127.0.0.1:8765/demo.html
# 自动测试（页面底部输出 PASS/FAIL）
# http://127.0.0.1:8765/demo.html?test=1
```

`demo.html` 模拟了列表、问卷、确认弹窗，覆盖：识别列表/表单、填 3 组单选、只填空的文本域、跳过已有文本、自检、单份提交、批量自动提交。

## 项目结构

```
.
├── nwafu-eval.user.js     # 主脚本
├── demo.html              # 本地模拟页 + 自动测试
├── README.md
├── LICENSE
└── legacy/python/         # 旧版 Selenium 实现（归档，不再维护）
    ├── main结果.py
    ├── main结果.spec
    ├── requirements.txt
    └── README.md
```

旧版 Python 依赖 Selenium + ChromeDriver，登录/驱动/打包问题较多；如果还要跑，按 `legacy/python/README.md` 准备环境和 `.env`。根目录的 `.env` 是旧版遗留，可删除或轮换。

## 许可证

MIT
