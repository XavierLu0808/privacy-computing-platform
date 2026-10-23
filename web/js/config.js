/**
 * 全局配置。
 *
 * useMock = true  → 所有请求走浏览器内的 mock-server.js（无需后端即可运行）
 * useMock = false → 所有请求打真实后端 apiBase，契约见 ../../API.md
 *
 * 接后端时只改这两行，业务代码一行不用动。
 */
window.APP_CONFIG = {
  apiBase: '/api/v1',
  useMock: true,
  accessToken: 'demo-token',
  // mock 模式下模拟的网络延迟（毫秒），设 0 可关闭
  mockLatencyMs: 80
};
