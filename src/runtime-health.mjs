import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Compare the loaded module version with the package currently on disk. */
export function createRuntimeHealth(runningVersion, packageRoot, { cacheMs = 1000, now = Date.now } = {}) {
  const root = packageRoot instanceof URL || (typeof packageRoot === 'string' && packageRoot.startsWith('file:'))
    ? fileURLToPath(packageRoot)
    : packageRoot;
  const packageFile = resolve(root, 'package.json');
  const ttl = Number.isFinite(cacheMs) ? Math.max(0, Math.min(1000, cacheMs)) : 1000;
  let cached;
  let cachedAt;

  return function getRuntimeHealth() {
    const checkedAt = now();
    if (cached && checkedAt >= cachedAt && checkedAt - cachedAt < ttl) return { ...cached };

    let installedVersion = null;
    try {
      const version = JSON.parse(readFileSync(packageFile, 'utf8')).version;
      if (typeof version === 'string' && VERSION.test(version)) installedVersion = version;
    } catch {
      // Missing/partially replaced package metadata is not evidence of an update.
    }
    cached = {
      runningVersion,
      installedVersion,
      restartRequired: installedVersion !== null && installedVersion !== runningVersion,
    };
    cachedAt = checkedAt;
    return { ...cached };
  };
}

export const RUNTIME_RESTART_HINT = '请先保存内容，通过“应用 → 退出”退出 DeepSeek Harness，再重新打开。Windows 上右上角 X 只会隐藏窗口，后台进程会保留旧插件。';
