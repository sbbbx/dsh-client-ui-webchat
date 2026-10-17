# dsh-client-ui-webchat

在 DSH 桌面端里开一个「网页版 DeepSeek」面板：不加一行模型代码，直接用网页端自己的会话，免费、不消耗 API 额度；两个方向都能搬——网页的回答一键带回 agent 会话，agent 的回答一键填回网页输入框。

## 为什么是内嵌浏览器

`chat.deepseek.com` 回 `Content-Security-Policy: frame-ancestors 'none'`，`<iframe>` 在任何宿主里都会被浏览器拒绝。桌面端主窗口开了 `webviewTag`，并且有两方验证的租约协议（`about:blank#<lease>` + partition 校验），所以只有作为插件挂在桌面端才成立；浏览器里的 Web GUI 没有这套东西，插件会自动隐身。

## 安装

```
dsh plugin install dsh-client-ui-webchat
```

或在 GUI 的插件管理器里 `install_bundle` 指向本目录。装完左侧多一个「网页版」入口。

## 用法

| 按钮 | 作用 | 花不花额度 |
| --- | --- | --- |
| 带走 | 选网页里的某一轮回答 → 可编辑预览 → 选工作区与会话 → 作为一条用户消息发出 | 花 |
| 喂回去 | 选当前会话里某一轮回答，再选写回网页的哪个对话，最后填进输入框（不自动发送，你看过再按网页的发送） | 不花 |
| 复制 | 同一份文本写进剪贴板（失败只在工具栏提示，不弹预览） | 不花 |
| 刷新 | 重建内嵌网页：关掉预览后页面变空白、或者页面卡死，都靠它恢复；登录态不丢 | 不花 |

「带走」的预览里有三个下拉：**网页轮次**（默认最后一轮）、**工作区**、**会话**。换轮次会重新抓那一轮的正文和它上面的提问，改过的文字不会跨轮次保留。会话下拉的第一项是「＋ 新会话」——选中它会先在该工作区新建一个 Session，再把文本发进去。发送后自动切到目标会话，好让你立刻看到它落进去了。会话标题优先读客户端的会话行（和图里侧边栏同一份数据），拿不到时退回 Host 的 projections，再退 id 前 8 位。

「喂回去」的预览里同样有下拉：**DSH 回答**（按新旧排，最新在最前，取最近 20 条）、**网页对话**（从网页侧边栏的链接里读；只有一个对话时不显示这个下拉）。选了别的对话会先在网页里切过去，等 1.6 秒再填，填进去的只是输入框内容。

预览这一步是故意的：DOM 抓出来的文本一定带噪声，直接投喂等于把噪声和 token 一起付钱。

## 兼容性

| 项 | 值 |
| --- | --- |
| 实测 DSH | `0.2.1-rc.2`（桌面端 shell 同为 `0.2.1-rc.2`） |
| `dsh.engines.dsh` | `^0.2.1-rc.2` |
| `peerDependencies` | `@deepseek-ai/dsh@^0.2.1-rc.2`、`react@^18.2.0` |

版本要求写在 `package.json` 的 `dsh.engines.dsh` 里，DSH 安装时会比对；不在范围内会直接拒绝安装，而不是装上去再崩。`0.x` 阶段按这个规则走：**动了私有接口就抬 minor（0.6 → 0.7），只改文案/修小 bug 抬 patch**——因为这个插件的每一次“功能”都直接踩在 DSH 的内部实现上，用 patch 号宣布接口没变过是在骗人。

四个依赖的上游内部点，任意一处改了就得跟着改：

1. `main` keyed 槽位的 `slots.register({ name:'main', key })` 与 `sidebar.panellist` 的 `id`/`order`/`label`。
2. `window.dshDesktop.browser` 的 `acquire` / `release` / `onOpenRequested` 租约桥（`about:blank#<lease>` + partition 校验）。
3. `remote.session.prompt` 与 `sessions.retain(..., { source:'gateway' })` 的事件窗口结构（`assistant/message` 带 `turn`/`step`，`user/message` 带 `source.kind`）。
4. `<webview>` 的默认高度问题：元素尺寸变了 guest 不重测，得靠一像素抖动逼它重排。

## 已知边界

- **每次启动 DSH 都要重新登录一次网页端。** 桌面端给插件的 partition 是按 workspace 现分配的随机内存会话（`dsh-sidebar-browser-*`，不带 `persist:`），app 一退就没了。官方侧栏浏览器同样如此，插件无法绕过。
- **仅桌面端。** 依赖 `window.dshDesktop.browser`（`acquire` / `release` / `onOpenRequested`），这是桌面端的私有桥；浏览器里的 Web GUI 不暴露。
- **依赖上游内部实现。** 面板挂在 `main` 槽位的 `webchat` key 上，走 `slots.register`；webview 走租约协议。DSH 升级改了任意一处，插件需要跟着改。
- **DOM 抓取是尽力而为。** 网页端的 class 名是构建期随机的，抓取逻辑按「找最后一块 markdown、往上找上一条提问」推断，改版后可能失效——失败了会退回手动粘贴。
- **只列出已渲染的轮次。** 网页端是虚拟列表，滚出视口的轮次不在 DOM 里，下拉里就看不到；想看更早的，先在网页里往上滚再点「带走」。
- **生成中拦截。** 「带走」「复制」抓取时把回答正文隔 450ms 采样两次，还在变就直接拒绝并提示等它停：塞进半截回答比抓空更糟。刻意不认页面上的「停止生成」按钮，那套类名每次构建都变。

## 开发

```
node --check client.js
node smoke.cjs
```

改完必须把 `package.json` 的 `version` 抬一格再重新安装：客户端模块按 rev 发 URL，同版本号会读到旧 bundle。

```
plugin_manager remove_bundle  dsh-client-ui-webchat
plugin_manager install_bundle E:\dsh projects\Github\dsh-client-ui-webchat
```

安装的 `application: applied` 即生效，不必重启 app。

## 文件

- `index.js` — host 半边，空实现（本插件不注册任何 Host 能力）。
- `client.js` — 全部逻辑：侧栏入口 + 主面板 + 常驻 webview + 双向搬运。
- `cordis.patch.yml` — 把 bundle 插进 profile。

MIT.
