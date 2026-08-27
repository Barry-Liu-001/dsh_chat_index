# dsh-chat-index

DeepSeek Harness (DSH) 对话索引插件：在对话区**右边缘显示一列小圆点**，每个点代表一条用户发送的消息。圆点**等间距、紧凑、纵向居中**排列（消息过多放不下时间距自动压缩以适应高度）；当前阅读位置的点高亮为品牌色。

- 鼠标悬停圆点 → 浮出该消息的**缩写提示卡**（序号 `#n` + 前 100 字）
- 点击圆点 → 平滑滚动到那条消息，并短暂高亮消息气泡
- 当前视口所在位置的圆点高亮为品牌色
- **自动展开历史分页**：会话消息较多时 DSH 会折叠更早的消息（需点击「加载更早」），导致索引不全；插件会**自动点击「加载更早」直到整段历史都加载渲染**，从而每条用户消息都能被索引（加载时外壳会锚定保持当前滚动位置，不会跳动）。如需关闭，把 `client.js` 顶部的 `AUTO_LOAD_OLDER` 改为 `false`。
- 纯 DOM/CSS 实现，零构建、零依赖；不读会话数据，只挂接对话壳的稳定 data 属性：
  - `[data-conversation-scroll]`（对话滚动容器）
  - `[data-chat-flow]`（消息流列）/ `[data-chat-flow-kind="user"]`（用户消息行）/ `[data-chat-flow-key]`（稳定 key）
  - `[data-composer-seat]`（底部输入区，轨道自动避让）

> 说明：自动展开历史意味着打开长会话时会把全部消息渲染到 DOM（DSH 分页本是为性能）。这是为完整索引有意为之；极长会话首次展开会稍多占内存。

## 安装

```sh
dsh plugin --profile web add /Users/bytedance/workspace/ark-5h-prompt/dsh-chat-index
```

然后重启 DSH Web（退出并重新运行 `dsh web`，或重开 DeepSeek Harness.app 会话）。对话区右侧即出现圆点索引（至少有 2 条用户消息时显示）。

> 插件通过 `cordis.patch.yml` 向 Loader 树插入一个空的 Node 端入口；浏览器 bundle 由 package.json 的 `dsh.client` + `exports["./client"]` 自动发现并加载。

## 卸载

```sh
dsh plugin --profile web remove dsh-chat-index
```

## 开发说明

- 浏览器端为手写的 client factory 经典脚本（`window.__ModuleLoader__.load`），改完 `client.js` 后重启 Web 生效；HMR 热替换仅在 `pnpm run dev:web` 的源码 checkout 中可用。
- 本地目录安装（pnpm link）时无需额外软链：本插件不 require 任何 DSH 包。
