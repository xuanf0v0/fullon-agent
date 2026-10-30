"""OpenAI 兼容 SSE 边界修复的单元测试。"""

import httpx
import pytest

from yuxi.modules.models.chat import _SseBoundaryRepairStream, _SseRepairTransport, _get_repair_async_client

MALFORMED = b'data: {"a":1}\ndata: {"b":2}\n\ndata: {"c":3}\n\n'
REPAIRED = b'data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c":3}\n\n'


class _ChunkStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes]):
        self._chunks = chunks

    async def __aiter__(self):
        for chunk in self._chunks:
            yield chunk


@pytest.mark.asyncio
async def test_repairs_adjacent_data_lines_across_chunk_boundaries():
    """相邻 data: 行被拆开，且任意字节切分都不能漏掉事件边界。"""
    for split in range(1, len(MALFORMED)):
        repaired = b"".join([chunk async for chunk in _SseBoundaryRepairStream(_ChunkStream([MALFORMED[:split], MALFORMED[split:]]))])
        assert repaired == REPAIRED

    bytewise = b"".join([chunk async for chunk in _SseBoundaryRepairStream(_ChunkStream([bytes([item]) for item in MALFORMED]))])
    assert bytewise == REPAIRED

    no_trailing_newline = MALFORMED.rstrip(b"\n")
    tail = b"".join([chunk async for chunk in _SseBoundaryRepairStream(_ChunkStream([no_trailing_newline]))])
    assert tail == REPAIRED.rstrip(b"\n")

    crlf = b'data: {"a":1}\r\ndata: {"b":2}\r\n\r\n'
    repaired_crlf = b"".join([chunk async for chunk in _SseBoundaryRepairStream(_ChunkStream([crlf]))])
    assert repaired_crlf == b'data: {"a":1}\r\n\ndata: {"b":2}\r\n\r\n'


@pytest.mark.asyncio
async def test_transport_only_repairs_event_stream_responses():
    """普通 JSON 响应保持原样，事件流才改写边界。"""
    payloads = {
        "/json": (b'{"ok": true}', "application/json"),
        "/sse": (MALFORMED, "text/event-stream"),
    }

    def handler(request: httpx.Request) -> httpx.Response:
        body, content_type = payloads[request.url.path]
        return httpx.Response(200, stream=_ChunkStream([body]), headers={"content-type": content_type})

    transport = _SseRepairTransport(httpx.MockTransport(handler))
    async with httpx.AsyncClient(transport=transport) as client:
        assert await (await client.get("https://example.com/json")).aread() == payloads["/json"][0]
        assert await (await client.get("https://example.com/sse")).aread() == REPAIRED


LEGAL_MULTILINE = b'data: {"choices": [\ndata: {"delta": {"content": "hi"}}\ndata: ]}\n\n'


@pytest.mark.asyncio
async def test_preserves_legal_multiline_data_events():
    """同一事件的多行 data 能拼成合法 JSON 时不得拆开。"""
    repaired = b"".join([chunk async for chunk in _SseBoundaryRepairStream(_ChunkStream([LEGAL_MULTILINE]))])

    assert repaired == LEGAL_MULTILINE


@pytest.mark.asyncio
async def test_stream_close_is_forwarded():
    """关闭修复流时必须关闭底层响应流，释放连接池。"""

    class ClosingStream(_ChunkStream):
        closed = False

        async def aclose(self):
            self.closed = True

    source = ClosingStream([MALFORMED])
    stream = _SseBoundaryRepairStream(source)
    _ = [chunk async for chunk in stream]

    await stream.aclose()

    assert source.closed is True


@pytest.mark.asyncio
async def test_repair_client_is_reused_and_disables_compression():
    """同一事件循环复用连接池，事件流请求不接受压缩。"""
    first = _get_repair_async_client()
    second = _get_repair_async_client()

    assert first is second
    assert first.headers["accept-encoding"] == "identity"
    # 共用客户端时沿用 OpenAI SDK 的连接池上限，避免并发流式请求排队
    assert _SseRepairTransport()._transport._pool._max_connections == 1000

    await first.aclose()
