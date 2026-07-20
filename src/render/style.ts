/**
 * CSS ของหน้าเว็บ — inline ทั้งก้อนใน <style> ของหน้าเดียว
 *
 * ทำไมไม่แยกไฟล์ .css แล้ว serve เป็น route ที่สอง: หน้านี้ต้อง self-contained 100%
 * (PLAN §3) — ผู้ใช้ต้อง save หน้าเป็นไฟล์เดียวแล้วยังอ่านได้ และต้องไม่มีคำขอออกนอก
 * เครื่องเลยแม้แต่ครั้งเดียว การมี asset แยกทำให้ทั้งสองข้อนี้พังทันที
 *
 * ทำไมไม่มี @font-face / ไม่มี Google Fonts: font ภายนอก = คำขอออกเน็ต + หน้าพังตอนออฟไลน์
 * จึงใช้ system font stack ซึ่งบน WSL/Windows/macOS มีฟอนต์ที่อ่านภาษาไทยได้อยู่แล้ว
 */

export const CSS = `
:root {
	color-scheme: light dark;
	--bg: #f6f7f9;
	--surface: #ffffff;
	--surface-2: #f0f2f5;
	--border: #d9dde3;
	--text: #1b1f24;
	--muted: #5c6773;
	--accent: #2f6feb;
	--accent-soft: #e5edff;
	--warn-bg: #fff4d6;
	--warn-border: #e0b64a;
	--warn-text: #6b4a00;
	--danger-bg: #ffe9e6;
	--danger-border: #e08b7d;
	--danger-text: #7a2718;
	--ok: #1f8a4c;
	--shadow: 0 1px 2px rgba(16, 24, 40, .06), 0 1px 3px rgba(16, 24, 40, .1);
}

@media (prefers-color-scheme: dark) {
	:root {
		--bg: #14171c;
		--surface: #1c2027;
		--surface-2: #232830;
		--border: #333a45;
		--text: #e7eaef;
		--muted: #9aa5b4;
		--accent: #6ea0ff;
		--accent-soft: #22314f;
		--warn-bg: #3a2f10;
		--warn-border: #8a6d1f;
		--warn-text: #f2d98b;
		--danger-bg: #3b1e19;
		--danger-border: #8c4438;
		--danger-text: #f3b4a8;
		--ok: #58c98a;
		--shadow: none;
	}
}

* { box-sizing: border-box; }

body {
	margin: 0;
	padding: 24px 20px 64px;
	background: var(--bg);
	color: var(--text);
	font-family: "Segoe UI", "Noto Sans Thai", "Sarabun", Tahoma, system-ui, -apple-system, sans-serif;
	font-size: 15px;
	line-height: 1.55;
	/* หน้าหลักห้าม scroll แนวนอน — ตารางกว้างต้องไปเลื่อนในกล่องตัวเองเท่านั้น (PLAN §4.5) */
	overflow-x: hidden;
}

.wrap { max-width: 1200px; margin: 0 auto; }

h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -.01em; }
h2 { font-size: 16px; margin: 0 0 12px; }
p { margin: 0 0 8px; }

.page-head {
	display: flex;
	flex-wrap: wrap;
	gap: 16px;
	align-items: flex-start;
	justify-content: space-between;
	margin-bottom: 20px;
}
.page-head .meta { color: var(--muted); font-size: 13px; }
.scope-path {
	font-family: ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace;
	font-size: 13px;
	background: var(--surface-2);
	border: 1px solid var(--border);
	border-radius: 6px;
	padding: 2px 7px;
	/* path ยาวมากต้องตัดคำได้ ไม่งั้นดัน layout จนหน้า scroll แนวนอน */
	word-break: break-all;
}

button {
	font: inherit;
	cursor: pointer;
	border-radius: 8px;
	border: 1px solid var(--accent);
	background: var(--accent);
	color: #fff;
	padding: 8px 16px;
	box-shadow: var(--shadow);
}
button:hover { filter: brightness(1.06); }
button[disabled] { opacity: .6; cursor: progress; }

/* ลิงก์ที่หน้าตาเป็นปุ่ม (ทางออกของ empty state) */
a.btn {
	display: inline-block;
	text-decoration: none;
	border-radius: 8px;
	border: 1px solid var(--accent);
	background: var(--accent);
	color: #fff;
	padding: 8px 16px;
	box-shadow: var(--shadow);
}
a.btn:hover { filter: brightness(1.06); }

.head-actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; justify-content: flex-end; }

/* toggle ขอบเขต — เป็นลิงก์จริง (back/forward + bookmark ใช้ได้) แต่หน้าตาเป็นปุ่มคู่ */
.scope-toggle {
	display: inline-flex;
	border: 1px solid var(--border);
	border-radius: 8px;
	overflow: hidden;
	background: var(--surface);
}
.scope-toggle .toggle-item {
	padding: 8px 14px;
	font-size: 13px;
	text-decoration: none;
	color: var(--muted);
	background: var(--surface);
	/* ชื่อโปรเจกต์ยาวได้ — ตัดด้วย ellipsis ไม่ให้ดันหน้าจน scroll แนวนอน */
	max-width: 260px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.scope-toggle .toggle-item + .toggle-item { border-left: 1px solid var(--border); }
.scope-toggle .toggle-item:hover { background: var(--surface-2); color: var(--text); }
.scope-toggle .toggle-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }

.empty-state a.btn { margin-top: 4px; }

.card, section.panel {
	background: var(--surface);
	border: 1px solid var(--border);
	border-radius: 12px;
	box-shadow: var(--shadow);
}

section.panel { padding: 16px; margin-bottom: 20px; }
section.panel > h2 { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }

.cards {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
	gap: 12px;
	margin-bottom: 20px;
}
.card { padding: 14px 16px; }
.card .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
.card .value { font-size: 24px; font-weight: 650; margin-top: 4px; font-variant-numeric: tabular-nums; }
.card .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }

.banner {
	border: 1px solid var(--warn-border);
	background: var(--warn-bg);
	color: var(--warn-text);
	border-radius: 10px;
	padding: 10px 14px;
	margin-bottom: 12px;
	font-size: 14px;
}
.banner.danger { border-color: var(--danger-border); background: var(--danger-bg); color: var(--danger-text); }
.banner strong { font-weight: 700; }
.banner ul { margin: 6px 0 0; padding-left: 20px; }

.badge {
	display: inline-block;
	font-size: 11px;
	font-weight: 600;
	padding: 1px 7px;
	border-radius: 999px;
	border: 1px solid var(--border);
	background: var(--surface-2);
	color: var(--muted);
	white-space: nowrap;
}
.badge.accent { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
.badge.warn { background: var(--warn-bg); border-color: var(--warn-border); color: var(--warn-text); }

/* กล่อง scroll ของตาราง — จุดเดียวในหน้าที่อนุญาตให้เลื่อนแนวนอนได้ */
.table-wrap { overflow-x: auto; }

/*
 * ตารางยาว (session / unmapped) ต้องเลื่อนในกล่องตัวเอง ห้ามดันหน้าให้ยาวจนกลบ section อื่น
 *
 * ที่มาของ 460px: วัดจาก CSS ในไฟล์นี้ — แถวหนึ่ง = padding 7px×2 + line-height 1.55×14px ≈ 36px
 * และหัวตาราง ≈ 30px  →  460px ≈ หัว + 12 แถว ซึ่งเป็นจำนวนที่ยัง "กวาดตาดูรวมๆ" ได้ในจอเดียว
 * ก่อนหน้านี้ข้อมูลจริง 136 แถว = สูงราว 4,900px กลบทั้งตารางโมเดลและถัง unmapped ที่อยู่ถัดลงไป
 * หัวตารางเป็น sticky อยู่แล้ว จึงยังอ่านชื่อคอลัมน์ได้ตลอดตอนเลื่อน
 */
.table-wrap.tall { max-height: 460px; overflow-y: auto; }

table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { padding: 7px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
thead th {
	position: sticky;
	top: 0;
	background: var(--surface-2);
	font-size: 12px;
	text-transform: uppercase;
	letter-spacing: .03em;
	color: var(--muted);
	white-space: nowrap;
}
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover td { background: var(--surface-2); }

/* แถวโปรเจกต์ = drill-in ได้ทั้งแถว (ลิงก์จริงอยู่ในช่องแรก JS แค่ขยายพื้นที่คลิก) */
tbody tr.row-link { cursor: pointer; }
tbody tr.row-link a { color: inherit; text-decoration: none; }
tbody tr.row-link:hover a { color: var(--accent); text-decoration: underline; }

/* ตัวเลขชิดขวา + ความกว้างหลักคงที่ ให้ไล่สายตาเทียบกันได้ (PLAN §4.5) */
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.money { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; font-weight: 600; }
.mono { font-family: ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace; font-size: 12.5px; }
.muted { color: var(--muted); }
.wrap-cell { max-width: 420px; word-break: break-word; }
.nowrap { white-space: nowrap; }

.chart-legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px; font-size: 13px; }
.chart-legend .item { display: flex; align-items: center; gap: 6px; color: var(--muted); }
.chart-legend .swatch { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
.chart-scroll { overflow-x: auto; }
svg.chart { display: block; min-width: 520px; }
svg.chart text { fill: var(--muted); font-size: 11px; }
svg.chart .grid { stroke: var(--border); stroke-width: 1; }
svg.chart .axis { stroke: var(--border); stroke-width: 1; }
/* เส้นประคั่นช่วงที่ไม่มีการใช้งาน — ต้องเห็นว่าวันไม่ต่อกัน แต่ต้องไม่เด่นกว่าตัวแท่ง */
svg.chart .gap { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 3 3; opacity: .55; }

footer {
	margin-top: 28px;
	padding-top: 14px;
	border-top: 1px solid var(--border);
	color: var(--muted);
	font-size: 12.5px;
}
footer code { word-break: break-all; }

.empty { color: var(--muted); font-style: italic; padding: 8px 0; }
`;
