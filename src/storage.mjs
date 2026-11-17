// 本机持久化入口。
import { validateState } from './domain.mjs';

export const STORAGE_KEY = 'meici.gym.v1';
export const BACKUP_KEY = 'meici.backup.v1';

export function loadData(storage = localStorage) {
  const raw = storage.getItem(STORAGE_KEY);
  // 已保存历史不能因手机校时或切换时区而被当成新录入的未来打卡。
  return { raw, state: raw === null ? { version: 1, cards: [] } : validateState(JSON.parse(raw)) };
}

export function saveData(state, storage = localStorage, expectedRaw) {
  const checked = validateState(state);
  if (expectedRaw !== undefined && storage.getItem(STORAGE_KEY) !== expectedRaw) {
    throw new Error('数据已在其他页面发生变化，请刷新后重试');
  }
  const raw = JSON.stringify(checked);
  try { storage.setItem(STORAGE_KEY, raw); }
  catch { throw new Error('本机保存失败，请检查存储空间或浏览器设置。本次改动尚未保存'); }
  return { state: checked, raw };
}

async function fingerprint(state) {
  const bytes = new TextEncoder().encode(JSON.stringify(validateState(state)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function prepareBackup(state, now = new Date()) {
  const snapshot = validateState(state), exportedAt = now.toISOString();
  return {
    content: JSON.stringify({ ...snapshot, exportedAt }, null, 2),
    metadata: { exportedAt, fingerprint: await fingerprint(snapshot) }
  };
}

// 仅标记“已生成下载”，浏览器无法保证用户已将文件保存到安全位置。
export function recordBackup(metadata, storage = localStorage) {
  try { storage.setItem(BACKUP_KEY, JSON.stringify(metadata)); }
  catch { throw new Error('备份已生成，但本机无法记录导出时间，请确认文件已保存'); }
}

export async function backupStatus(state, storage = localStorage, now = new Date()) {
  let raw;
  try { raw = storage.getItem(BACKUP_KEY); } catch { return { reason: 'unavailable' }; }
  let metadata;
  try { metadata = JSON.parse(raw); } catch { return { reason: 'never' }; }
  if (!metadata || typeof metadata.exportedAt !== 'string' || !Number.isFinite(Date.parse(metadata.exportedAt)) || !/^[a-f0-9]{64}$/.test(metadata.fingerprint)) return { reason: 'never' };
  const days = Math.max(0, Math.floor((now.getTime() - Date.parse(metadata.exportedAt)) / 86400000));
  let current;
  try { current = await fingerprint(state); } catch { return { reason: 'unavailable' }; }
  const reason = current !== metadata.fingerprint ? 'changed' : days >= 7 ? 'due' : 'current';
  return { reason, exportedAt: metadata.exportedAt, days };
}
