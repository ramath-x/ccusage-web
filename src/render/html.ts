/**
 * helper เล็กๆ ที่ทั้ง page.ts และ chart.ts ใช้ร่วมกัน
 *
 * ทำไมแยกเป็นไฟล์ที่สี่ทั้งที่แผนเขียนไว้แค่ page/chart/style: page.ts import chart.ts
 * ถ้าเอา escapeHtml ไปไว้ใน page.ts แล้วให้ chart.ts import กลับ จะเกิด circular import
 * ซึ่ง ESM รันได้ก็จริงแต่พังง่ายเวลาแตะลำดับ import ทีหลัง — แลกด้วยไฟล์เล็กๆ หนึ่งไฟล์คุ้มกว่า
 */

/**
 * escape ทุกค่าที่มาจากข้อมูลก่อนหยอดลง HTML
 *
 * ทำไมต้องมี: `aiTitle` และ `cwd` มาจากไฟล์ของผู้ใช้ที่ agent เขียนไว้ ซึ่งเราไม่ได้ควบคุมเนื้อหา
 * ชื่อ session มาจากสิ่งที่ AI ตั้งให้ตามบทสนทนา — สนทนาเรื่องโค้ด HTML/JS เมื่อไหร่
 * ชื่อก็มี `<script>` หรือ `"` ติดมาได้ตามปกติ (ไม่ต้องมีคนจงใจโจมตี หน้าก็พังแล้ว)
 * ปล่อยดิบ = ทั้ง XSS และ layout พังจากแท็กที่ไม่ได้ปิด
 *
 * escape `'` ด้วยเพราะเราใช้ค่าพวกนี้ใน attribute (เช่น title=) ที่บางจุดคร่อมด้วย single quote ได้
 */
export function escapeHtml(value: unknown): string {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

const MONEY_FORMAT = new Intl.NumberFormat('en-US', {
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
});

const INT_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** เงิน: ทศนิยม 2 ตำแหน่งเสมอ + คั่นหลักพัน (PLAN §4.5) */
export function money(value: number): string {
	return `$${MONEY_FORMAT.format(Number.isFinite(value) ? value : 0)}`;
}

/** token: จำนวนเต็ม + คั่นหลักพัน */
export function tokens(value: number): string {
	return INT_FORMAT.format(Number.isFinite(value) ? value : 0);
}

/**
 * ย่อ token ให้อ่านง่ายบนการ์ดสรุป (1.2M / 45.3K)
 * ใช้เฉพาะที่ต้องการ "ขนาดคร่าวๆ" — ในตารางยังใช้ตัวเต็มเสมอเพื่อให้เอาไปกระทบยอดได้
 */
export function compactTokens(value: number): string {
	const v = Number.isFinite(value) ? value : 0;
	if (Math.abs(v) >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
	if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
	if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
	return INT_FORMAT.format(v);
}

/**
 * แปลง ISO timestamp เป็น `YYYY-MM-DD HH:mm UTC`
 *
 * ทำไมพิมพ์ UTC ฝั่ง server แทนที่จะแปลงเป็นเวลาท้องถิ่นเลย: HTML ที่ server เจนต้องอ่านรู้เรื่อง
 * แม้ JS ปิด และ server ไม่มีทางรู้ timezone ของ browser — จึงพิมพ์ UTC ที่ไม่มีทางกำกวมไว้ก่อน
 * แล้วให้สคริปต์ inline แปลงเป็นเวลาเครื่องผู้ใช้ทีหลัง (ดู page.ts)
 */
export function formatUtc(iso: string | undefined): string {
	if (!iso) return '—';
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const pad = (n: number): string => String(n).padStart(2, '0');
	return (
		`${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
		`${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
	);
}

/** `<time>` ที่ฝั่ง client เอาไปแปลงเป็นเวลาท้องถิ่นได้ — ไม่มี JS ก็ยังอ่าน UTC ได้ */
export function timeTag(iso: string | undefined): string {
	if (!iso) return '<span class="muted">—</span>';
	return `<time datetime="${escapeHtml(iso)}">${escapeHtml(formatUtc(iso))}</time>`;
}
