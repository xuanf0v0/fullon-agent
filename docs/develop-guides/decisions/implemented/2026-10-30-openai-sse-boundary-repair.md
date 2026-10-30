# OpenAI 兼容 SSE 相邻事件修复

状态：implemented
类型：bug-fix
Owner：backend/yuxi/modules/models/chat.py

## 问题

部分 OpenAI 兼容端点把两个 JSON 写成相邻的 `data:` 行而不插入空行。按 SSE 规范这是同一事件的多行数据，OpenAI SDK 会把两段 JSON 合在一起 `json.loads`，抛出 `Extra data: line 2 column 1`，整个 Agent Run 以 `execution_error` 失败。

## 决策

### 实现方案

- 在 `ChatCompletionsAdapter` 的异步 HTTP 客户端上安装 `_SseRepairTransport`：仅当响应 `content-type` 包含 `text/event-stream` 时包装字节流，其他响应原样透传。
- `_SseBoundaryRepairStream` 按行维护 SSE 状态：上一条 `data:` 是本事件首行、以 `}` 结尾且自身是完整 JSON 时，才在当前 `data:` 行前插入空行。合法的多行事件（首行不是完整 JSON，或后续行不属于事件首行）保持不变。
- 流式解析按行缓冲，任意 chunk 切分都不会漏行；`aclose()` 转发到底层响应流，连接能归还连接池。
- 修复客户端按事件循环复用（`WeakKeyDictionary`），避免每次加载模型新建连接池；连接池上限与 OpenAI SDK 默认一致（1000/100），保持并发能力。
- 请求头固定 `Accept-Encoding: identity`，避免压缩后的 SSE 绕过行级判断。
- 调用方已提供 `http_async_client` 时保持原样；Anthropic 与 Gemini 分支不受影响。

## 替代方案

- 模型配置 `stream=false`：非流式响应可绕过该端点，但会跳过模型 lifecycle 事件，Run 以「最终 State AIMessage 无法与当前 Run 的 Model lifecycle 事实关联」失败；不采用。
- 切换供应商：可行但把协议缺陷转嫁给部署者，且已配置的模型不可用。
- 全局放宽 `json.loads` 或只解析首个 JSON：会丢失同一事件中的后续 JSON，可能吞掉正文。
- 纯字节替换 `}\ndata:`：会把合法的多行事件拆坏；不采用。
- 代理层修复：需要额外进程或网关，超出运行时边界。

## 后果

- 修复对所有 OpenAI 兼容供应商生效；符合规范的单行/多行 SSE 不会被改动。
- 同步客户端仍走 SDK 默认传输，没有修复；当前 Agent 运行时使用异步流。
- 自定义异步客户端不参与 httpx 的代理挂载；当前部署未配置代理，需要代理时应显式提供 `http_async_client`。
- 强制 `Accept-Encoding: identity` 会让模型响应不再使用 gzip/br 压缩。
- LangChain 会对自定义 transport 打印代理探测提示；该提示不影响直连。
- 端点若返回其他形态的畸形 SSE（例如事件间缺少 `data:` 前缀），仍会失败。
- 拆分依赖「上一条 data 是事件首行且为完整 JSON」；若连续畸形事件的上一行不是事件首行，不会继续拆分。

## 验证

| 验收主张 | 失败面 | 语义 Owner | 直接证据 / 命令 | 负向案例 | 当前结果 |
|---|---|---|---|---|---|
| 相邻 data 行在任意 chunk 切分下被拆开 | 边界字节漏改或重复 | `chat.py` `_SseBoundaryRepairStream` | `pytest test/unit/models/test_model_sse_repair.py`（5 passed：全部切分点、逐字节、CRLF、末尾无换行、多行合法事件、close 转发、客户端复用与连接上限） | 合法多行事件与普通 JSON 不改写 | Passed |
| 事件流关闭释放连接池 | 每次流式请求泄漏连接 | `chat.py` `aclose` | 同文件 close 转发测试；实现审查确认底层 `PoolByteStream` 被关闭 | 合法流不额外插入空行 | Passed |
| 真实端点流式解析成功 | SDK 仍报 Extra data | `chat.py` `_SseRepairTransport` | `load_chat_model('zy:deepseek-v4.1-flash').astream(...)`：9 chunks，正文完整 | 修复前同一请求抛 `JSONDecodeError` | Passed |
| Agent Run 端到端完成 | Run 仍失败或正文错误 | `ChatCompletionsAdapter` | 真实 HTTP 提交消息：`agent_runs.execution_seq=9` status=completed，输出消息为 `OK` | 修复前 `execution_seq=5` 与 6 均 failed | Passed |
