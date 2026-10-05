# dsh-select-ask

[English](README.md) | 中文

在 DSH Web UI 的对话里选中一段文字，然后要么**引用**进输入框，要么在**一次性侧栏小窗**里就它提问
—— 就是 Codex 里那两个习惯。

## 它做什么

**引用**。在对话里（或任何非输入框区域）选中文字，选区附近浮出 `引用` / `侧栏提问` 小工具条。
引用不会把原文倒进输入框，而是给 composer 挂上**注释**：

- 输入框上方出现一枚小框 `1 条注释`；鼠标移上去展开列出每条注释（编号 + 所选文本），
  每条右侧可单独删除，小框的 `×` 清除全部；
- 输入框正文里每条引用只占一枚**无文字小图标** chip；
- 发送时每枚 chip 展开成消息里的一段 Markdown 引用块（`> …`）。

**侧栏提问**。`侧栏提问` 在右侧栏开一个钉住该片段的标签页。它是一个自成一体的小对话：每一轮就是
一次 POST 到 Host 半注册的路由，由 Host 半跑一次**无工具的** `ctx.llm.stream`。
**不会创建任何会话** —— 没有 session log、没有 workspace 条目、没有子会话；对话只活在组件 state 里，
关掉标签页即丢弃。模型与凭据照走正常通道（取选词时所在会话的当前请求配置，取不到时回落到默认模型
选择），所以适配器、重试、凭据与计量与普通回合完全一致。

## 引用是怎么送到模型那里的

引用必须"送到模型但不占输入框"，所以它借用 composer 自己的 **reference chip** 机制，而不是正文。
每条引用是一枚 chip：`ref` **就是**被引文字，正文投影（`clipboardText`）只是一小段标记，
模型文本由本包注册的 codec 给出：

```js
ctx.inputTriggers.registerSource({
  trigger: "@",
  name: "select-ask",
  candidates: async () => [],       // 不进 `@` 菜单，也不做纯文本装饰
  showGroupTitle: false,
  codec: {
    clipboardText: () => "[注释]",   // 草稿文本里显示什么
    serialize: (ref) => Promise.resolve("\n\n" + blockquote(ref) + "\n"),  // 模型拿到什么
  },
});
```

插入与删除走 composer 的 scoped input 事件：`slash/input-insert-reference` 放 chip，
`slash/input-consume-token` 带 span 删 chip。两者都对实时的 draft revision 做 CAS，所以"用户刚好敲了
一个键"只会输掉这次竞争并触发重试；chip 的 detect 偏移由 occurrence 列表推出
（`detectOffset = clipboardOffset − Σ(length−1)`，减去它前面每枚 chip 多出来的字符数），
因此草稿里有没有别的插件 chip 都不影响算术。

小框的计数直接数 *draft* 里的 chip（`InputState.occurrences`），所以计数、悬浮列表、模型文本读的是
同一份数据，不可能对不上。序列化失败会**拒绝发送**（`slash: no serializer for reference source …`），
而不是静默把标记文本发出去。

如果 chip 完全插不进去（拿不到 session scope，或修订号一直抢跑），插件退化成"把引用块追加进正文"，
并在控制台说明原因 —— 难看，但不会丢。

## 安全边界

`/dsh-select-ask/ask` 会消耗模型额度，因此由 `isTrustedRequest()` 守卫：一个只依赖请求头的纯函数判定，
自带单测（`node --test test/trusted-request.test.mjs`）：

- **token 已武装** —— 某次 index 渲染真的把本次激活的 token 交给了页面，那么请求必须带回
  `x-dsh-select-ask`，其余一律拒绝。Host 半用 `webServer.tapIndex` 注入 token，浏览器半从
  `window.__DSH_SELECT_ASK_TOKEN__` 读取；自定义请求头同时让跨站表单打不进来。
- **token 未武装** —— 有些部署里窗口的 index 根本不走 `webServer.renderIndex`（DSH Desktop 2.0.15
  实测如此），token 永远到不了页面。此时：凡声明了浏览器来源（`Origin`/`Referer`）的请求必须与本机
  同源；完全不带来源头的请求放行 —— 它与这个 DSH profile 已经暴露的其它 loopback 接口同信任级。

`GET /dsh-select-ask/status` 会报告当前生效的是哪一种（`guard` 字段）以及解析到的模型。
验证「不留记录」：调用前后比较 `~/.dsh/sessions` 下的文件时间戳与数量 —— 小窗问答不会新增会话文件。

## 安装

```sh
# 在 Full access 的会话里：
# plugin_manager action=install_bundle target=<本目录>
```

装完刷新 Web UI 页面，新的客户端 bundle 才会进入 boot graph。**Host 半**（`host.js`）的改动需要重启
DSH：Host 模块的世代按进程缓存，行的 specifier 无法就地重新导入。

### 插件市场

[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 目录的投稿规则是
"一个插件一个 YAML 条目、一个 PR 一个文件"；本仓库的条目在
[`submission/YizhouLouisLu__dsh-select-ask.yml`](submission/YizhouLouisLu__dsh-select-ask.yml)。

## 状态

开发与验证环境：**dsh core 0.2.0-rc.2**（DSH Desktop 2.0.15-beta.1）。暂未声明 `engines.dsh` 范围：
实际跑过的只有这个版本。

## 给插件作者的经验（踩过的坑）

- **Host 模块缓存按"行的 specifier"缓存，生存期是整个进程。** 关掉再打开 bundle 不会重新导入，
  对已安装的 bundle 再跑 `install_bundle` 也不会重读它的 `cordis.patch.yml`。要立刻生效：
  `remove_bundle` → `install_bundle`，并且行的 `name` 与已经导入过的那个不同 —— 或者重启 DSH。
- **Loader 的行名不能是子路径 specifier。** `pkg/subpath` 在这里会 `failed to import`，
  尽管普通 Node 能解析它。
- **客户端半的改动需要刷新页面**（只有在跑 `pnpm run dev:web` 时客户端 HMR 才会自动重建）。
- **cordis 服务只有在"声明过它"的 fiber 里才能作为属性读到。** 用
  `ctx.inject(['webServer'], (scope) => scope.webServer…)`；只调 `ctx.get('webServer')` 并不能让
  `ctx.webServer` 变得可读。
- **用户消息气泡是"纯文本 + chip"，不是 Markdown。** 前端的 `projectUserText` 只把
  `@[label](dsh-session:…)` mention、纯 `@token`、`/command` 渲染成 chip；Markdown 链接、HTML 注释
  之类一律原样显示。所以插件**无法**把内容藏进用户消息 —— 那需要消息自带结构化 annotation 字段，
  或者让内容走消息之外的通道。

## 已知限制

- 尚未发送的注释只活在 composer 的草稿镜像里。刷新页面或切换会话时，草稿镜像只留得下标记文本，
  引用正文会丢（插件挂载时会清掉这种孤立标记，避免把 `[注释]` 当正文发出去）。已发送的引用在消息里，
  不受影响。
- 引用正文在你发出的气泡里是可见的（Markdown 引用块）。在气泡里藏起来对插件来说做不到：
  气泡渲染的就是消息正文本身（见上）。
- 输入框里每条引用显示为一枚无文字小图标（`label: ""` + `appearance: "session"`；
  不给 appearance 时 chip 会渲染一个裸 `@`）。
- 侧栏是**页面型**标签：页面型在同一 pane 内去重，所以再次「侧栏提问」会复用同一个小窗，
  并以新的选中文字重置它。
- 小窗回答按纯文本渲染（保留换行），那里没有 Markdown 渲染器。
- 侧栏小窗内选中的文字不会再次弹出工具条（避免自我嵌套）。
- 工具条写入的是**最后挂载**的那个 composer；同时开着侧栏 chat 标签页时可能不是主会话的。

## License

MIT —— 见 [LICENSE](LICENSE)。
