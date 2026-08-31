# dsh-chat-index

DeepSeek Harness (DSH) 对话索引插件：在 Web UI 对话区**右边缘显示一列小圆点**，每个点代表一条用户发送的问题。圆点**等间距、紧凑、纵向居中**排列（问题过多放不下时间距自动压缩以适应高度）；当前阅读位置的点高亮为品牌色。

- 鼠标悬停圆点 → 浮出该问题的**缩写提示卡**（序号 `#n` + 前 100 字）
- 点击圆点 → 平滑滚动到那条消息，并短暂高亮消息气泡
- 当前视口所在位置的圆点高亮为品牌色
- **全部问题都可见，且不展开历史**：圆点索引来自 Host 端的一个轻量端点（`/chat-index.questions`），返回该会话**所有用户问题**的 `{seq, time, id, text}` 列表（几 KB）。客户端保持 DSH 默认的 **50 条消息窗口**，不会自动点击「加载更早」把整段历史塞进内存
- **按需分页**：点击某个**未加载**的旧消息圆点时，才临时分页加载到那条消息（有界、只到点击位置，不是整段历史），然后滚动过去
- 零构建：Node 端是普通 ESM，浏览器端是手写的 client factory 经典脚本（React 由 DSH shell 注入）
- **不干预任何折叠/展开状态**：工具调用、终端输出、思考过程等折叠内容保持 DSH 原生行为

## 前置条件

- DSH 0.1.1-rc.x 或更高（Web profile）
- Node.js ≥ 18

## 安装

`dsh plugin` 会转发给 pnpm 并自动把插件写入 profile 的 bundles 列表，所以 pnpm 支持的来源都可以装。任选一种：

```sh
# 方式 A：直接从 GitHub 安装（无需发布，推荐）
dsh plugin --profile web add github:Barry-Liu-001/dsh_chat_index

# 方式 B：从 npm 安装（发布后可用，见下文「发布与分发」）
dsh plugin --profile web add dsh-chat-index

# 方式 C：本地 tgz 安装（离线 / 审计后安装）
dsh plugin --profile web add ./dsh-chat-index-0.1.0.tgz

# 方式 D：本地源码目录（插件开发，workspace link）
dsh plugin --profile web add /path/to/dsh-chat-index
```

然后重启 DSH Web（`dsh web` 或重新打开 DeepSeek Harness.app 会话），对话区右侧即出现圆点索引（至少有 2 条用户消息时显示）。

> 插件通过 `cordis.patch.yml` 向 Loader 树插入 Node 入口（注册 `/chat-index.questions` 精确路由），浏览器 bundle 由 package.json 的 `dsh.client` + `exports["./client"]` 自动发现并加载。
>
> 方式 A/B/C 都会把包解包进 profile 的 `node_modules`，依赖可正常向上解析，无需任何额外操作；只有方式 D（源码 link）需要按文末「开发说明」补一个 `@deepseek-ai` 软链。

## 工作原理

```
浏览器圆点 rail
   │  fetch('/chat-index.questions?session=<id>')   (同源 GET, 返回 JSON)
   ▼
Node 端 dsh-chat-index/index.js（webServer 精确路由）
   │  缓存有效（<10s）→ 直接返回
   │  缓存过期 → ctx.sessionQuery.readSession(<id>) 读完整日志
   ▼
过滤 source.kind === 'user' 的 user/message 事件
   → 返回 [{ seq, time, id, text }, ...]（id 是 messageId，text 是问题正文）
```

- **数据来源**：`ctx.sessionQuery.readSession`（DSH 公开服务，即使内容搜索关闭也能用），Host 端每次临时读一次 zstd 日志、过滤、只回传轻量问题列表，按会话 10s TTL 缓存。
- **客户端映射**：圆点与已渲染气泡通过 DOM `data-chat-flow-key`（=`N:input-message` + messageId）对应；点击已加载消息直接滚动，未加载消息走按需分页。

## 开发说明（workspace link 方式）

以本地目录 `dsh plugin add /path/to/dsh-chat-index` 安装时，pnpm 用软链指向源码目录，Node 从源码目录向上解析不到 DSH 的依赖闭包。本地开发时补一个软链即可：

```sh
mkdir -p node_modules
ln -sfn ~/.dsh/profiles/node_modules/@deepseek-ai node_modules/@deepseek-ai
```

以 tgz 形式安装（`dsh plugin add ./dsh-chat-index-0.1.0.tgz`，文件会解包到 profile 的 node_modules 里）则无需任何额外操作。

改 `client.js` 后刷新浏览器即可（bundle 以 no-cache 提供）；改 `index.js` / `cordis.patch.yml` 后需要重启 `dsh web`。

## 卸载

```sh
dsh plugin --profile web remove dsh-chat-index
```

## 发布与分发（维护者）

插件零构建、零运行时 dependencies（DSH 宿主能力全部走 optional peerDependencies），所以三种分发方式都不需要编译步骤：

```sh
# 1) 打 tgz（产物 dsh-chat-index-<version>.tgz，只含 package.json files 白名单里的 5 个文件）
npm pack
#   → 附到 GitHub Release，用户用「方式 C」安装；也可直接发给同事

# 2) 发布到 npm（公共 registry，所有人可装）
npm login --registry https://registry.npmjs.org
npm publish --registry https://registry.npmjs.org
#   → 用户用「方式 B」：dsh plugin --profile web add dsh-chat-index

# 3) 什么都不用发：代码推到 GitHub 后，用户直接用「方式 A」从 git 安装
#   （本插件无 prepare 构建脚本，git 安装不会触发 pnpm 的 allowBuilds 拦截）
```

发布前检查清单：

- [ ] `package.json` 的 `version` 已按 semver bump（npm 不允许覆盖已发布版本）
- [ ] `npm pack --dry-run` 确认 tarball 内容（应只有 LICENSE / README.md / client.js / cordis.patch.yml / index.js / package.json，不含 node_modules）
- [ ] 改动已合入 `main` 并推送到 GitHub（方式 A 始终装默认分支最新代码）
