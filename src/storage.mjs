// 本机持久化入口。
import { validateState } from './domain.mjs';

export const STORAGE_KEY = 'meici.gym.v1';

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
