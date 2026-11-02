const { URL } = require('node:url')

/** 从原始请求行提取同源路径，避免 `//host` 被解析成协议相对 URL。 */
function parseRequestPath(rawUrl, localOrigin) {
  const parsed = new URL(rawUrl, localOrigin)
  return { pathname: parsed.pathname, requestPath: `${parsed.pathname}${parsed.search}` }
}

/** 代理目标始终基于配置的后端 origin，不接受请求中的 host。 */
function buildProxyTarget(requestPath, baseUrl, rewrite) {
  return new URL(rewrite ? rewrite(requestPath) : requestPath, baseUrl)
}

module.exports = { parseRequestPath, buildProxyTarget }
