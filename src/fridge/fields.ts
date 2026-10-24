// Derived fields the fridge-book App and its import task must compute identically.
// The App (冰箱账本 artifact) has the same chainOf / slugOf / cacheKey in its page
// script — change both together, or nutriCache lookups stop matching.

export type FridgeChain = 'migros' | 'coop' | 'other';

/** Store name → chain: contains "coop" → coop; contains "migros" or starts with "M " → migros. */
export function chainOf(store: string): FridgeChain {
  const s = String(store || '');
  if (/coop/i.test(s)) return 'coop';
  if (/migros/i.test(s) || /^M\s/.test(s)) return 'migros';
  return 'other';
}

/** Lower-case, fold umlauts/accents, runs of non [a-z0-9] → "-", trim "-", max 100 chars. */
export function slugOf(s: string): string {
  return String(s || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[éèê]/g, 'e').replace(/[àâ]/g, 'a')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
}

/** nutriCache key: chain + ":" + slug(receipt name), falling back to the German name; "" if neither. */
export function nutriKey(store: string, name: string, de = ''): string {
  const s = slugOf(name) || slugOf(de);
  return s ? `${chainOf(store)}:${s}` : '';
}

/** Default fridge/pantry shelf life in days, from the purchase date. */
export const SHELF_DAYS: Record<string, number> = {
  '生肉禽鱼': 2,
  '熟食冷切': 5,
  '巴氏奶': 7,
  '酸奶': 10,
  '奶酪': 21,
  '豆腐': 5,
  '鸡蛋': 21,
  '绿叶菜': 4,
  '番茄西葫芦': 6,
  '其他蔬菜': 7,
  '根茎类南瓜': 20,
  '苹果': 21,
  '柑橘': 14,
  '香蕉': 5,
  '浆果': 3,
  '其他水果': 7,
  '面包': 2,
  '宝宝果泥零食': 60,
  '冷冻食品': 60,
  '干货': 180,
};

export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + Math.round(days));
  return dt.toISOString().slice(0, 10);
}
