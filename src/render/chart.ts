/**
 * กราฟแท่งรายวัน — SVG เขียนเอง ไม่มี chart library (PLAN §4.5)
 *
 * ทำไมไม่ใช้ Chart.js/D3: ทั้งคู่ต้องโหลดจาก CDN หรือ bundle เข้ามา ซึ่งขัดข้อบังคับสองข้อ
 * ของโปรเจกต์นี้พร้อมกัน — ห้ามมี dependency เพิ่ม (PLAN §3) และหน้าต้องใช้งานได้ออฟไลน์
 * กราฟที่เราต้องการเป็นแค่แท่งซ้อนตามวัน ซึ่งเขียน SVG ตรงๆ สั้นกว่าการตั้งค่า lib เสียอีก
 */

import type { UsageRow } from '../ccusage.js';
import { escapeHtml, money } from './html.js';

/**
 * จำนวนวันสูงสุดที่วาด (นับจากวันล่าสุดย้อนกลับ)
 *
 * ที่มา: ข้อมูลจริงบนเครื่องนี้ (2026-07-20) มี 32 แถวรายวัน กินช่วง 2026-03-04 → 2026-07-20
 * คือ ~4.5 เดือนของการใช้งานจริงยังไม่ถึง 60 แถว (ccusage คืนเฉพาะวันที่มีการใช้งาน)
 * เลือก 60 = ~2 เท่าของที่วัดได้ ให้ผู้ใช้หนักกว่านี้ยังเห็นครบ แต่ยังไม่ทำให้แท่งบางจนอ่านไม่ออก
 * เกินกว่านี้จะตัดแล้วบอกจำนวนที่ตัดไว้ใต้กราฟ ไม่ตัดเงียบ
 */
export const MAX_CHART_DAYS = 60;

/**
 * จานสีของ agent — เลือกโทนกลางที่ contrast พอทั้งพื้นสว่างและพื้นมืด
 * (สีอ่อนจัดจะจมพื้นขาว สีเข้มจัดจะจมพื้นดำ — ธีมสองโหมดใช้ชุดเดียวกันจึงต้องอยู่ตรงกลาง)
 */
const PALETTE = ['#4b8bf5', '#f2994a', '#27ae8e', '#b06ee0', '#e0607e', '#c2a53a', '#5aa9c9', '#8d8fa5'];

const WIDTH_PER_BAR = 26;
const MIN_WIDTH = 520;
const HEIGHT = 260;
const PAD_LEFT = 62;
const PAD_RIGHT = 14;
const PAD_TOP = 12;
const PAD_BOTTOM = 38;

export interface DailyChartResult {
	svg: string;
	/** ชื่อ agent → สี — เอาไปทำ legend นอก SVG (legend เป็น HTML จัดวางง่ายกว่า) */
	colors: Array<{ agent: string; color: string }>;
	/** จำนวนวันที่ถูกตัดทิ้งเพราะเกิน MAX_CHART_DAYS */
	hiddenDays: number;
}

/** ปัดเพดานแกน y ขึ้นเป็นเลขกลมๆ เพื่อให้เส้น grid อ่านง่าย (ไม่ใช่ 37.418) */
function niceCeil(value: number): number {
	if (value <= 0) return 1;
	const magnitude = 10 ** Math.floor(Math.log10(value));
	const normalized = value / magnitude;
	const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
	return step * magnitude;
}

/** ยอดต่อ agent ของหนึ่งวัน — ใช้ `agents[]` ที่มาจาก --by-agent ถ้ามี ไม่มีก็นับทั้งวันเป็นก้อนเดียว */
function costsByAgent(row: UsageRow): Map<string, number> {
	const result = new Map<string, number>();
	const children = Array.isArray(row.agents) ? row.agents : [];

	if (children.length > 0) {
		for (const child of children) {
			const cost = typeof child.totalCost === 'number' ? child.totalCost : 0;
			result.set(child.agent, (result.get(child.agent) ?? 0) + cost);
		}
		return result;
	}

	// ไม่มี breakdown ต่อ agent — ใช้ชื่อ agent ของแถวเอง ("all" ตอน ccusage รวมให้แล้ว)
	result.set(row.agent || 'ทั้งหมด', typeof row.totalCost === 'number' ? row.totalCost : 0);
	return result;
}

/**
 * วาดกราฟแท่งซ้อน: แกน x = วัน, แกน y = cost, สีแยกตาม agent
 *
 * @param dailyRows แถว `daily` จาก ccusage (เรียงเก่า→ใหม่ตามที่ ccusage คืนมา)
 */
export function renderDailyChart(dailyRows: UsageRow[]): DailyChartResult {
	const usable = dailyRows.filter((row) => typeof row.period === 'string');
	const hiddenDays = Math.max(0, usable.length - MAX_CHART_DAYS);
	const rows = usable.slice(-MAX_CHART_DAYS);

	if (rows.length === 0) {
		return { svg: '<p class="empty">ไม่มีข้อมูลรายวันในช่วงที่เลือก</p>', colors: [], hiddenDays: 0 };
	}

	const perDay = rows.map((row) => ({ period: row.period, costs: costsByAgent(row) }));

	// เรียงชื่อ agent แบบคงที่ เพื่อให้สีของ agent เดิมไม่สลับไปมาทุกครั้งที่กด Refresh
	const agentNames = [...new Set(perDay.flatMap((day) => [...day.costs.keys()]))].sort();
	const colorOf = new Map(
		agentNames.map((agent, i) => [agent, PALETTE[i % PALETTE.length] as string] as const),
	);

	const dayTotals = perDay.map((day) => [...day.costs.values()].reduce((a, b) => a + b, 0));
	const yMax = niceCeil(Math.max(...dayTotals));

	const plotWidth = Math.max(MIN_WIDTH - PAD_LEFT - PAD_RIGHT, rows.length * WIDTH_PER_BAR);
	const width = plotWidth + PAD_LEFT + PAD_RIGHT;
	const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
	const slot = plotWidth / rows.length;
	const barWidth = Math.max(3, Math.min(30, slot * 0.68));

	const parts: string[] = [];

	// เส้น grid + ป้ายแกน y (5 ระดับ 0..yMax)
	const GRID_STEPS = 4;
	for (let i = 0; i <= GRID_STEPS; i += 1) {
		const value = (yMax / GRID_STEPS) * i;
		const y = PAD_TOP + plotHeight - (plotHeight * i) / GRID_STEPS;
		parts.push(`<line class="grid" x1="${PAD_LEFT}" y1="${y.toFixed(1)}" x2="${width - PAD_RIGHT}" y2="${y.toFixed(1)}" />`);
		parts.push(
			`<text x="${PAD_LEFT - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${escapeHtml(money(value))}</text>`,
		);
	}

	// แท่งซ้อนต่อวัน
	perDay.forEach((day, index) => {
		const x = PAD_LEFT + slot * index + (slot - barWidth) / 2;
		let cursor = PAD_TOP + plotHeight;

		for (const agent of agentNames) {
			const cost = day.costs.get(agent) ?? 0;
			if (cost <= 0) continue;
			const height = (cost / yMax) * plotHeight;
			cursor -= height;
			parts.push(
				`<rect x="${x.toFixed(1)}" y="${cursor.toFixed(1)}" width="${barWidth.toFixed(1)}" ` +
					`height="${Math.max(height, 0.6).toFixed(1)}" fill="${colorOf.get(agent)}" rx="2">` +
					// tooltip ของ browser เอง — ไม่ต้องเขียน JS tooltip ให้บวม
					`<title>${escapeHtml(`${day.period} · ${agent} · ${money(cost)}`)}</title>` +
					`</rect>`,
			);
		}
	});

	// ป้ายแกน x — โชว์ทุกๆ n วันเพื่อไม่ให้ตัวหนังสือทับกันตอนวันเยอะ
	const labelEvery = Math.max(1, Math.ceil(rows.length / 12));
	perDay.forEach((day, index) => {
		if (index % labelEvery !== 0 && index !== perDay.length - 1) return;
		const cx = PAD_LEFT + slot * index + slot / 2;
		// ตัดปีออกให้เหลือ MM-DD พอ — ปีเต็มอยู่ในหัวข้อช่วงวันที่แล้ว
		const label = day.period.length >= 10 ? day.period.slice(5) : day.period;
		parts.push(
			`<text x="${cx.toFixed(1)}" y="${HEIGHT - PAD_BOTTOM + 16}" text-anchor="middle">${escapeHtml(label)}</text>`,
		);
	});

	parts.push(
		`<line class="axis" x1="${PAD_LEFT}" y1="${PAD_TOP + plotHeight}" x2="${width - PAD_RIGHT}" y2="${PAD_TOP + plotHeight}" />`,
	);

	const svg =
		`<svg class="chart" viewBox="0 0 ${width} ${HEIGHT}" width="${width}" height="${HEIGHT}" ` +
		`role="img" aria-label="กราฟ cost รายวันแยกตาม agent">${parts.join('')}</svg>`;

	return {
		svg,
		colors: agentNames.map((agent) => ({ agent, color: colorOf.get(agent) as string })),
		hiddenDays,
	};
}
