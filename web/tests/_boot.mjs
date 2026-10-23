// 测试公共启动器：在同一个 vm 沙箱里加载 mock 内核 js/mock-server.js 和全部扩展 js/mock/*.js，
// 计时器用 node:test 的 mock.timers 驱动。各模块测试 import { boot } from './_boot.mjs'。
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('../js/', import.meta.url);
const CORE = readFileSync(new URL('mock-server.js', ROOT), 'utf8');
const EXT = readdirSync(new URL('mock/', ROOT)).filter((f) => f.endsWith('.js')).sort()
  .map((f) => ({ f, src: readFileSync(new URL('mock/' + f, ROOT), 'utf8') }));

export function boot(t) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const window = { APP_CONFIG: { mockLatencyMs: 0 } };
  const sandbox = {
    window, URLSearchParams, console, Date,
    setTimeout: (...a) => setTimeout(...a), clearTimeout: (x) => clearTimeout(x),
    setInterval: (...a) => setInterval(...a), clearInterval: (x) => clearInterval(x)
  };
  vm.createContext(sandbox);
  vm.runInContext(CORE, sandbox, { filename: 'mock-server.js' });
  EXT.forEach(({ f, src }) => vm.runInContext(src, sandbox, { filename: 'mock/' + f }));
  const M = window.MockServer;
  // vm 沙箱里的对象原型与本 realm 不同，JSON 往返后再比较（也顺带验证响应可序列化）
  const call = async (method, url, body) => JSON.parse(JSON.stringify(await M.handle(method, url, body)));
  const okData = async (method, url, body) => {
    const r = await call(method, url, body);
    assert.equal(r.code, 0, `${method} ${url} → ${r.code} ${r.message}`);
    return r.data;
  };
  const errCode = async (method, url, body) => (await call(method, url, body)).code;
  const download = async (url) => JSON.parse(JSON.stringify(await M.download(url)));
  return { M, window, call, okData, errCode, download, tick: (ms) => t.mock.timers.tick(ms) };
}
