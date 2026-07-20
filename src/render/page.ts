/**
 * ประกอบหน้า HTML ทั้งหน้า — server-side render, ไม่มี framework, ไม่มี asset ภายนอก
 *
 * กติกาแกนของไฟล์นี้: **ทุกค่าที่มาจากข้อมูลต้องผ่าน escapeHtml() ก่อนเสมอ**
 * (เหตุผลเต็มอยู่ที่ html.ts) — ที่นี่มีทั้ง path ในเครื่อง, ชื่อ session ที่ AI ตั้ง (ภาษาไทย/อักขระพิเศษ),
 * ชื่อโมเดล และข้อความ warning ซึ่งไม่มีอันไหนที่เราควบคุมเนื้อหาได้จริง
 */

import type { UsageRow } from '../ccusage.js';
import type { Report, ReportSession } from '../report.js';
// import type เท่านั้น — snapshot.ts import PageData กลับมาที่ไฟล์นี้ ถ้าเป็น import ปกติจะเป็น
// วงจร runtime; `import type` ถูกลบทิ้งตอน compile จึงไม่มีวงจรจริงเหลืออยู่
import type { ScopeLinks } from '../snapshot.js';
import { renderDailyChart } from './chart.js';
import { compactTokens, escapeHtml, money, timeTag, tokens } from './html.js';
import { CSS } from './style.js';

/**
 * เพดานแถวของตาราง session ในหน้าแรก (PLAN §7)
 *
 * ที่มา: ข้อมูลจริงบนเครื่องนี้มี 155 session รวมทั้งเครื่อง และโปรเจกต์ที่ใหญ่ที่สุดมี 131 session
 * คือ "ผู้ใช้หนักจริง" ยังไม่ชนเพดาน 200 — เลือกไว้ให้เกินของจริงเล็กน้อยเพื่อให้เคสปกติเห็นครบ
 * ส่วนเครื่องที่ log สะสมเป็นพัน จะได้ไม่ต้องเรนเดอร์ DOM หลายพันแถวทุกครั้งที่เปิดหน้า
 * ตัดแล้ว**ต้องบอกจำนวนที่ซ่อน** เสมอ — ตัวเลขที่หายแบบเงียบๆ อันตรายกว่าตารางยาว
 */
export const MAX_SESSION_ROWS = 200;

/** ข้อมูลทั้งหมดที่หน้าเว็บต้องใช้ — server เก็บก้อนนี้ไว้เป็น snapshot ล่าสุด */
export interface PageData {
	report: Report;
	/**
	 * แถว `daily` ดิบจาก ccusage
	 *
	 * ⚠️ ตัวเลขชุดนี้เป็น **ทั้งเครื่องเสมอ** แม้ผู้ใช้ดูแบบเจาะโปรเจกต์
	 * เพราะ ccusage ไม่ได้ผูก project เข้ากับยอดรายวัน (PLAN §2 ข้อ 2) และ session
	 * มีแค่ `lastActivity` ซึ่งกระจายยอดทั้ง session ไปลงวันเดียวไม่ได้โดยไม่โกหก
	 * จึงเลือกโชว์ของจริงพร้อมป้ายกำกับ แทนที่จะเดายอดรายวันของโปรเจกต์
	 */
	daily: UsageRow[];
	/** แถว `session` ดิบ — ใช้ดึง modelBreakdowns ที่ report model ไม่ได้เก็บไว้ */
	sessionRows: UsageRow[];
	/** ccusage ตัวที่ใช้จริง (footer) */
	binary: string;
	/** true = ราคาที่เห็นมาจาก cache ไม่ใช่ตารางราคาปัจจุบัน */
	usedOfflineFallback: boolean;
	/** true = ผู้ใช้สั่ง --offline เอง (ไม่ใช่ระบบถอยให้) */
	offlineRequested: boolean;
	collectedAt: string;
	/**
	 * ลิงก์สลับ scope — ไม่ใส่ = ไม่ต้องวาดปุ่ม toggle (เช่นเทสที่สนใจแค่ตาราง)
	 * เป็นลิงก์จริงไม่ใช่ JS เพื่อให้สลับได้แม้ปิด JS และให้กด "เปิดในแท็บใหม่" ได้
	 */
	scopeLinks?: ScopeLinks;
	/** error ของการ Refresh ครั้งล่าสุด — snapshot เดิมยังโชว์อยู่ แต่ต้องบอกผู้ใช้ว่าข้อมูลเก่า */
	lastRefreshError?: string;
}

interface ModelTotal {
	modelName: string;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	cost: number;
	sessionCount: number;
}

/**
 * รวม modelBreakdowns เฉพาะ session ที่อยู่ในขอบเขตที่ดูอยู่
 *
 * ทำไมไม่ใช้ `totals` ของ ccusage ตรงๆ: อันนั้นเป็นยอดทั้งเครื่อง พอผู้ใช้ดูเจาะโปรเจกต์
 * ตาราง model จะไม่ตรงกับการ์ดสรุปด้านบน — ตัวเลขสองชุดในหน้าเดียวที่ไม่ตรงกัน
 * คือสิ่งที่ทำให้คนเลิกเชื่อทั้งหน้า จึงกรองด้วย sessionId ที่อยู่ใน report จริงๆ
 */
export function aggregateModels(report: Report, sessionRows: UsageRow[]): ModelTotal[] {
	const inScope = new Set<string>();
	for (const project of report.projects) {
		for (const session of project.sessions) inScope.add(session.sessionId);
	}
	// unmapped นับรวมเฉพาะโหมดดูทั้งเครื่อง ให้ตรงกับกติกาของ totals ใน report.ts
	if (report.scope.mode === 'all') {
		for (const session of report.unmapped.sessions) inScope.add(session.sessionId);
	}

	const byModel = new Map<string, ModelTotal>();
	for (const row of sessionRows) {
		if (!inScope.has(row.period)) continue;
		const breakdowns = Array.isArray(row.modelBreakdowns) ? row.modelBreakdowns : [];
		for (const item of breakdowns) {
			const name = typeof item.modelName === 'string' && item.modelName ? item.modelName : '(ไม่ระบุ)';
			let total = byModel.get(name);
			if (!total) {
				total = {
					modelName: name,
					inputTokens: 0,
					outputTokens: 0,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					cost: 0,
					sessionCount: 0,
				};
				byModel.set(name, total);
			}
			total.inputTokens += num(item.inputTokens);
			total.outputTokens += num(item.outputTokens);
			total.cacheCreationTokens += num(item.cacheCreationTokens);
			total.cacheReadTokens += num(item.cacheReadTokens);
			total.cost += num(item.cost);
			total.sessionCount += 1;
		}
	}

	return [...byModel.values()].sort((a, b) => b.cost - a.cost);
}

function num(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** ชื่อที่โชว์ในตาราง session — aiTitle ก่อน ไม่มีค่อยใช้ UUID 8 ตัวแรก (PLAN §4.5) */
export function sessionLabel(session: ReportSession): string {
	const title = session.title?.trim();
	if (title) return title;
	return session.sessionId.slice(0, 8);
}

function scopeTitle(report: Report): string {
	if (report.scope.mode === 'all') return 'ทั้งเครื่อง (ทุกโปรเจกต์ ทุก agent)';
	return report.scope.resolvedPath ?? report.scope.requestedPath ?? '(ไม่ทราบ path)';
}

/**
 * ช่วงวันที่ของข้อมูล **ในขอบเขตที่กำลังดู**
 *
 * ทำไมไม่ใช้แถว daily ตรงๆ ทุกโหมด: daily เป็นยอดทั้งเครื่องเสมอ (PLAN §2 ข้อ 2)
 * พอผู้ใช้ดูเจาะโปรเจกต์ที่เพิ่งเริ่มเดือนนี้ header จะยังขึ้น "2026-03-04 → 2026-07-20"
 * ซึ่งเป็นช่วงของโปรเจกต์อื่น = การ์ดกับหัวข้อคนละ population กัน
 * โหมด project จึงคำนวณจาก lastActivity ของ session ที่อยู่ในขอบเขตจริงแทน
 */
function dateRangeText(report: Report, daily: UsageRow[]): string {
	const periods =
		report.scope.mode === 'all'
			? daily.map((row) => row.period).filter((p): p is string => typeof p === 'string')
			: report.projects.flatMap((project) =>
					project.sessions
						.map((session) => session.lastActivity)
						.filter((value): value is string => typeof value === 'string')
						.map((value) => value.slice(0, 10)),
				);

	const sorted = [...periods].sort();
	const first = sorted[0];
	const last = sorted[sorted.length - 1];
	if (!first || !last) return 'ไม่มีข้อมูลในช่วงที่เลือก';
	return first === last ? first : `${first} → ${last}`;
}

function renderBanners(data: PageData): string {
	const { report } = data;
	const banners: string[] = [];

	// ⚠️ ห้ามโชว์ราคาจาก cache เงียบๆ — วัดจริงแล้วต่างจากราคาออนไลน์ได้ระดับ 3.5%
	// ($2,748 vs $2,848 บนข้อมูลชุดเดียวกัน) ผู้ใช้ที่เอาตัวเลขไปเบิกจ่ายต้องรู้ว่ามันไม่ใช่ราคาปัจจุบัน
	if (data.usedOfflineFallback) {
		const why = data.offlineRequested
			? 'คุณสั่ง <code>--offline</code> ไว้'
			: 'ดึงตารางราคาจากอินเทอร์เน็ตไม่สำเร็จ ระบบจึงถอยไปใช้ราคาที่ cache ไว้ให้อัตโนมัติ';
		banners.push(
			`<div class="banner"><strong>ราคานี้มาจากตารางที่ cache ไว้ ไม่ใช่ราคาปัจจุบัน</strong> — ${why}<br>` +
				`ตัวเลข cost ที่เห็นอาจคลาดเคลื่อนจากราคาจริง (เคยวัดได้ต่างกันราว 3.5%) ` +
				`ถ้าต้องการตัวเลขตรงที่สุด ให้ต่อเน็ตแล้วกด Refresh อีกครั้ง</div>`,
		);
	}

	if (data.lastRefreshError) {
		banners.push(
			`<div class="banner danger"><strong>Refresh ล่าสุดไม่สำเร็จ</strong> — ข้อมูลที่เห็นอยู่คือชุดก่อนหน้า ` +
				`(เก็บเมื่อ ${escapeHtml(data.collectedAt)})<br><code>${escapeHtml(data.lastRefreshError)}</code></div>`,
		);
	}

	if (!report.meta.claudeProjectsDirExists) {
		banners.push(
			`<div class="banner">ไม่พบโฟลเดอร์ <code>${escapeHtml(report.meta.claudeProjectsDir)}</code> — ` +
				`ระบุโปรเจกต์ให้ session ของ Claude Code ไม่ได้ ทุก session จึงไปกองอยู่ที่ "ระบุโปรเจกต์ไม่ได้" ด้านล่าง</div>`,
		);
	}

	// ⚠️ ไม่มี banner สำหรับเคส "หาโปรเจกต์ไม่เจอ" ตรงนี้โดยตั้งใจ — renderEmptyState() ทำหน้าที่นั้นแทน
	// (เคยมีทั้งสองอันแล้วหน้าขึ้นข้อความเดียวกันซ้อนกันสองบล็อกติดกัน อ่านแล้วสับสนว่าเป็นคนละปัญหา)

	const trustIssues = report.projects.filter((project) => !project.pathTrusted);
	if (trustIssues.length > 0) {
		banners.push(
			`<div class="banner"><strong>${trustIssues.length} โปรเจกต์มี path ที่เดามาจากชื่อโฟลเดอร์</strong> ` +
				`(อ่าน <code>cwd</code> จากไฟล์ log ไม่เจอ) — path ที่แสดงอาจไม่ตรงกับของจริง ` +
				`ยอด cost ยังถูกต้อง แต่การจับกลุ่มเข้าโปรเจกต์อาจเพี้ยน</div>`,
		);
	}

	if (report.meta.warnings.length > 0) {
		const items = report.meta.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
		banners.push(`<div class="banner"><strong>คำเตือนตอนสแกน log</strong><ul>${items}</ul></div>`);
	}

	return banners.join('\n');
}

function renderCards(data: PageData): string {
	const { report } = data;
	const t = report.totals;
	const sessionCount = report.projects.reduce((sum, p) => sum + p.sessionCount, 0);
	const totalSessions = report.scope.mode === 'all' ? sessionCount + report.unmapped.sessionCount : sessionCount;
	// โหมดทั้งเครื่องต้องนับ agent ของ session ที่ระบุโปรเจกต์ไม่ได้ด้วย (เช่น gemini)
	// เพราะ cost ของมันถูกรวมอยู่ใน totals ที่การ์ด "cost รวม" โชว์แล้ว — ถ้านับแต่ agent
	// ฝั่ง projects การ์ดจะบอกว่าใช้แค่ claude ทั้งที่ยอดข้างๆ มี gemini ปนอยู่ (นับให้ตรงกับ
	// บรรทัด totalSessions ด้านบนที่ทำแบบเดียวกันอยู่แล้ว)
	const agents = [
		...new Set([
			...report.projects.flatMap((p) => p.agents),
			...(report.scope.mode === 'all' ? report.unmapped.sessions.map((s) => s.agent) : []),
		]),
	].sort();

	const cards: Array<{ label: string; value: string; sub?: string }> = [
		{
			label: 'cost รวม',
			value: money(t.totalCost),
			sub: report.scope.mode === 'all' ? 'รวม session ที่ระบุโปรเจกต์ไม่ได้แล้ว' : 'เฉพาะโปรเจกต์นี้',
		},
		{ label: 'token รวม', value: compactTokens(t.totalTokens), sub: `${tokens(t.totalTokens)} tokens` },
		{ label: 'จำนวน session', value: tokens(totalSessions), sub: `${tokens(report.projects.length)} โปรเจกต์` },
		{
			label: 'agent ที่ใช้',
			value: agents.length > 0 ? escapeHtml(agents.join(', ')) : '—',
			sub: `cache read ${compactTokens(t.cacheReadTokens)}`,
		},
	];

	return (
		'<div class="cards">' +
		cards
			.map(
				(card) =>
					`<div class="card"><div class="label">${escapeHtml(card.label)}</div>` +
					`<div class="value">${card.value}</div>` +
					(card.sub ? `<div class="sub">${escapeHtml(card.sub)}</div>` : '') +
					'</div>',
			)
			.join('') +
		'</div>'
	);
}

function renderChartSection(data: PageData): string {
	const chart = renderDailyChart(data.daily);
	const legend =
		chart.colors.length > 0
			? '<div class="chart-legend">' +
				chart.colors
					.map(
						(item) =>
							`<span class="item"><span class="swatch" style="background:${escapeHtml(item.color)}"></span>` +
							`${escapeHtml(item.agent)}</span>`,
					)
					.join('') +
				'</div>'
			: '';

	// ป้ายนี้สำคัญ: ในโหมดเจาะโปรเจกต์ กราฟยังเป็นยอดทั้งเครื่อง ถ้าไม่บอกผู้ใช้จะอ่านผิดทันที
	const scopeNote =
		data.report.scope.mode === 'project'
			? '<span class="badge warn">ทั้งเครื่อง — ccusage ไม่ได้แยกยอดรายวันต่อโปรเจกต์</span>'
			: '';

	/**
	 * คำอธิบายใต้กราฟ — **ต้องบอกเสมอว่าที่เห็นคือช่วงไหนและวันว่างหายไปไหน**
	 *
	 * เพราะกราฟวาดเฉพาะวันที่มีการใช้งาน (ccusage คืนมาแค่นั้น) แท่งจึงชิดกันหมด
	 * ผู้ใช้ที่ไม่รู้จะอ่านว่า "ใช้ทุกวันต่อเนื่อง" ทั้งที่จริงเว้นไปเป็นเดือน
	 */
	const notes: string[] = [];
	if (chart.shownDays > 0 && chart.firstPeriod && chart.lastPeriod) {
		notes.push(
			`แสดง ${tokens(chart.shownDays)} วันที่มีการใช้งาน ช่วง ${escapeHtml(chart.firstPeriod)} → ${escapeHtml(chart.lastPeriod)}`,
		);
	}
	if (chart.gapCount > 0) {
		notes.push(
			`เส้นประ = ช่วงที่ไม่ได้ใช้งาน (${tokens(chart.gapCount)} ช่วง รวม ${tokens(chart.gapDays)} วันที่ไม่มีข้อมูล จึงไม่มีแท่ง)`,
		);
	}
	if (chart.hiddenDays > 0) {
		notes.push(`ซ่อนวันที่เก่ากว่านี้อีก ${tokens(chart.hiddenDays)} วัน`);
	}
	const note = notes.length > 0 ? `<p class="muted" style="margin-top:8px">${notes.join(' · ')}</p>` : '';

	return (
		`<section class="panel"><h2>cost รายวัน ${scopeNote}</h2>` +
		`<div class="chart-scroll">${chart.svg}</div>${legend}${note}</section>`
	);
}

/**
 * หน้าตอน cwd/path ที่ขอ ไม่ตรงกับโปรเจกต์ไหนเลย (PLAN §4.3 + M4)
 *
 * เป็น "ผลว่าง" ไม่ใช่ error — ยืนอยู่ในโฟลเดอร์ที่ไม่เคยเปิด agent เป็นเรื่องปกติมาก
 * สิ่งที่ผู้ใช้ต้องการตรงนี้คือ **ทางออกที่กดได้ทันที** ไม่ใช่คำสั่งให้ไปพิมพ์ใหม่ในเทอร์มินัล
 */
function renderEmptyState(data: PageData): string {
	const { report } = data;
	if (report.scope.mode !== 'project' || report.scope.matched) return '';

	const href = data.scopeLinks?.allHref ?? '/?scope=all';
	return (
		'<section class="panel empty-state"><h2>ยังไม่มีข้อมูลของโฟลเดอร์นี้</h2>' +
		`<p><span class="mono">${escapeHtml(report.scope.resolvedPath ?? report.scope.requestedPath ?? '')}</span></p>` +
		'<p class="muted">ไม่พบ session ของ Claude Code ที่ผูกกับ path นี้ — อาจเป็นเพราะยังไม่เคยใช้ agent ในโฟลเดอร์นี้ ' +
		'หรือใช้ผ่าน agent ที่ระบุโปรเจกต์ไม่ได้ (ดูหัวข้อ "ระบุโปรเจกต์ไม่ได้" ด้านล่าง)</p>' +
		`<p style="margin-top:12px"><a class="btn" href="${escapeHtml(href)}">ดูทั้งเครื่องแทน</a></p>` +
		// บอกทางฝั่งเทอร์มินัลไว้ด้วย สำหรับคนที่เปิดหน้านี้ค้างแล้วอยากรันใหม่ให้ default เป็นทั้งเครื่อง
		'<p class="muted" style="margin-top:8px">หรือรันใหม่ด้วย <code>ccusage-web --all</code></p></section>'
	);
}

function renderProjectsTable(report: Report): string {
	if (report.scope.mode !== 'all') return '';
	if (report.projects.length === 0) {
		return '<section class="panel"><h2>โปรเจกต์</h2><p class="empty">ยังไม่มีโปรเจกต์ที่ระบุได้</p></section>';
	}

	const rows = report.projects
		.map((project) => {
			const trust = project.pathTrusted
				? ''
				: ` <span class="badge warn" title="${escapeHtml(`ที่มาของ path: ${project.pathSource}`)}">path เดาจากชื่อโฟลเดอร์</span>`;
			// drill-in (M4): เป็น <a> จริงเพื่อให้คลิกกลางเปิดแท็บใหม่ได้และใช้งานได้แม้ปิด JS
			// (JS ทำแค่ขยายพื้นที่คลิกให้ทั้งแถว ดู INLINE_SCRIPT)
			const href = `/?project=${encodeURIComponent(project.projectPath)}`;
			return (
				`<tr class="row-link" data-href="${escapeHtml(href)}">` +
				`<td class="wrap-cell"><a class="mono" href="${escapeHtml(href)}">${escapeHtml(project.projectPath)}</a>${trust}</td>` +
				`<td class="num">${tokens(project.sessionCount)}</td>` +
				`<td>${escapeHtml(project.agents.join(', ') || '—')}</td>` +
				`<td class="num">${tokens(project.totalTokens)}</td>` +
				`<td class="money">${money(project.totalCost)}</td>` +
				`<td class="nowrap">${timeTag(project.lastActivity)}</td>` +
				'</tr>'
			);
		})
		.join('');

	return (
		'<section class="panel"><h2>โปรเจกต์ <span class="badge">เรียงตาม cost มาก→น้อย</span>' +
		'<span class="badge">คลิกแถวเพื่อเจาะดูเฉพาะโปรเจกต์นั้น</span></h2>' +
		'<div class="table-wrap"><table><thead><tr>' +
		'<th>โปรเจกต์</th><th class="num">session</th><th>agent</th><th class="num">token</th>' +
		'<th class="num">cost</th><th>ใช้ล่าสุด</th>' +
		`</tr></thead><tbody>${rows}</tbody></table></div></section>`
	);
}

interface SessionRow extends ReportSession {
	projectPath?: string;
}

function renderSessionsTable(report: Report): string {
	const all: SessionRow[] = [];
	for (const project of report.projects) {
		for (const session of project.sessions) all.push({ ...session, projectPath: project.projectPath });
	}
	all.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));

	if (all.length === 0) {
		return '<section class="panel"><h2>session</h2><p class="empty">ยังไม่มี session ในขอบเขตนี้</p></section>';
	}

	const shown = all.slice(0, MAX_SESSION_ROWS);
	const hidden = all.length - shown.length;

	const rows = shown
		.map((session) => {
			// title= ใส่ UUID เต็มไว้ให้เอาไปค้นไฟล์ log ต่อได้ โดยไม่ต้องกินพื้นที่ในตาราง
			const label = `<span title="${escapeHtml(session.sessionId)}">${escapeHtml(sessionLabel(session))}</span>`;
			const project = session.projectPath
				? `<td class="wrap-cell mono">${escapeHtml(session.projectPath)}</td>`
				: '<td class="muted">—</td>';
			return (
				'<tr>' +
				`<td class="wrap-cell">${label}</td>` +
				(report.scope.mode === 'all' ? project : '') +
				`<td>${escapeHtml(session.agent)}</td>` +
				`<td class="wrap-cell muted">${escapeHtml(session.modelsUsed.join(', ') || '—')}</td>` +
				`<td class="num">${tokens(session.totalTokens)}</td>` +
				`<td class="money">${money(session.totalCost)}</td>` +
				`<td class="nowrap">${timeTag(session.lastActivity)}</td>` +
				'</tr>'
			);
		})
		.join('');

	const note =
		hidden > 0
			? `<p class="muted" style="margin-top:10px">แสดง ${tokens(shown.length)} แถวแรกจากทั้งหมด ${tokens(all.length)} ` +
				`— ซ่อนไว้อีก ${tokens(hidden)} แถว (ดูครบได้ที่ <code>/api/report</code>)</p>`
			: '';

	/**
	 * badge ต้องบอกให้ชัดว่านับ population ไหน
	 *
	 * ตารางนี้มีเฉพาะ session ที่ **ระบุโปรเจกต์ได้** ส่วนการ์ด "จำนวน session" ด้านบน
	 * ในโหมดทั้งเครื่องรวม unmapped ด้วย (เพราะ cost ของมันถูกรวมใน totals) สองเลขจึงไม่เท่ากันโดยตั้งใจ
	 * ถ้าไม่กำกับไว้ ผู้ใช้จะเห็น "155" กับ "136" ข้างกันแล้วสรุปว่าหน้านี้นับเลขไม่ตรง
	 */
	const badge =
		report.scope.mode === 'all' && report.unmapped.sessionCount > 0
			? `${all.length} รายการ (เฉพาะที่ระบุโปรเจกต์ได้)`
			: `${all.length} รายการ`;

	return (
		`<section class="panel"><h2>session <span class="badge">${escapeHtml(badge)}</span></h2>` +
		// tall = จำกัดความสูงแล้วเลื่อนในกล่องตัวเอง ไม่ให้ตารางยาวกลบ section ที่เหลือทั้งหน้า
		'<div class="table-wrap tall"><table><thead><tr>' +
		'<th>ชื่อ session</th>' +
		(report.scope.mode === 'all' ? '<th>โปรเจกต์</th>' : '') +
		'<th>agent</th><th>model</th><th class="num">token</th><th class="num">cost</th><th>ใช้ล่าสุด</th>' +
		`</tr></thead><tbody>${rows}</tbody></table></div>${note}</section>`
	);
}

function renderModelsTable(data: PageData): string {
	const models = aggregateModels(data.report, data.sessionRows);
	if (models.length === 0) {
		return '<section class="panel"><h2>แยกตามโมเดล</h2><p class="empty">ไม่มีข้อมูล modelBreakdowns</p></section>';
	}

	const rows = models
		.map(
			(model) =>
				'<tr>' +
				`<td class="mono wrap-cell">${escapeHtml(model.modelName)}</td>` +
				`<td class="num">${tokens(model.inputTokens)}</td>` +
				`<td class="num">${tokens(model.outputTokens)}</td>` +
				`<td class="num">${tokens(model.cacheCreationTokens)}</td>` +
				`<td class="num">${tokens(model.cacheReadTokens)}</td>` +
				`<td class="money">${money(model.cost)}</td>` +
				'</tr>',
		)
		.join('');

	return (
		'<section class="panel"><h2>แยกตามโมเดล</h2><div class="table-wrap"><table><thead><tr>' +
		'<th>model</th><th class="num">input</th><th class="num">output</th>' +
		'<th class="num">cache write</th><th class="num">cache read</th><th class="num">cost</th>' +
		`</tr></thead><tbody>${rows}</tbody></table></div></section>`
	);
}

/**
 * ถัง unmapped — **ต้องโชว์เสมอ ห้ามซ่อน** (PLAN M2)
 * ถ้าซ่อน ผู้ใช้จะเห็นยอดที่น้อยกว่าความจริงโดยไม่รู้ว่ามีก้อนที่ระบุโปรเจกต์ไม่ได้อยู่
 */
function renderUnmapped(report: Report): string {
	const bucket = report.unmapped;
	if (bucket.sessionCount === 0) return '';

	const reasonLabels: Record<string, string> = {
		'agent-not-supported': 'agent ไม่ได้เก็บ log แยกต่อ session',
		'no-log-file': 'หาไฟล์ log ของ session ไม่เจอ',
	};
	const reasons = Object.entries(bucket.byReason)
		.filter(([, count]) => count > 0)
		.map(([reason, count]) => `<li>${escapeHtml(reasonLabels[reason] ?? reason)}: ${tokens(count)} session</li>`)
		.join('');

	const shown = [...bucket.sessions]
		.sort((a, b) => b.totalCost - a.totalCost)
		.slice(0, MAX_SESSION_ROWS);
	const hidden = bucket.sessionCount - shown.length;

	const rows = shown
		.map(
			(session) =>
				'<tr>' +
				`<td class="wrap-cell"><span title="${escapeHtml(session.sessionId)}">${escapeHtml(sessionLabel(session))}</span></td>` +
				`<td>${escapeHtml(session.agent)}</td>` +
				`<td class="wrap-cell muted">${escapeHtml(session.reasonText)}</td>` +
				`<td class="num">${tokens(session.totalTokens)}</td>` +
				`<td class="money">${money(session.totalCost)}</td>` +
				'</tr>',
		)
		.join('');

	// ถัง unmapped เป็นของ**ทั้งเครื่องเสมอ** (คำนวณก่อนกรอง scope) — ในโหมดเจาะโปรเจกต์
	// ต้องบอกให้ชัด ไม่งั้นผู้ใช้จะนึกว่าเป็น session ที่หลุดจากโปรเจกต์ที่กำลังดูอยู่
	const inTotals =
		report.scope.mode === 'all'
			? 'ยอดก้อนนี้ <strong>รวมอยู่</strong> ในการ์ด cost รวมด้านบนแล้ว'
			: 'ยอดก้อนนี้เป็นของ <strong>ทั้งเครื่อง</strong> และ <strong>ไม่ได้รวม</strong> ในการ์ดด้านบน ' +
				'เพราะยืนยันไม่ได้ว่า session เหล่านี้เป็นของโปรเจกต์ที่กำลังดูอยู่หรือไม่';

	const note =
		hidden > 0
			? `<p class="muted" style="margin-top:10px">แสดง ${tokens(shown.length)} แถวที่ cost สูงสุด — ซ่อนไว้อีก ${tokens(hidden)} แถว</p>`
			: '';

	return (
		'<section class="panel"><h2>ระบุโปรเจกต์ไม่ได้ ' +
		`<span class="badge warn">${escapeHtml(`${bucket.sessionCount} session · ${money(bucket.totalCost)}`)}</span></h2>` +
		`<p class="muted">${inTotals}</p><ul class="muted">${reasons}</ul>` +
		'<div class="table-wrap"><table><thead><tr>' +
		'<th>ชื่อ session</th><th>agent</th><th>เหตุผล</th><th class="num">token</th><th class="num">cost</th>' +
		`</tr></thead><tbody>${rows}</tbody></table></div>${note}</section>`
	);
}

/**
 * สคริปต์ inline ตัวเดียวของหน้า
 *
 * มีแค่สองหน้าที่: ยิง Refresh แล้วโหลดหน้าใหม่ กับแปลงเวลา UTC เป็นเวลาเครื่องผู้ใช้
 * ทุกอย่างที่เหลือ render มาจาก server แล้ว — ปิด JS ทิ้งหน้ายังอ่านได้ครบ
 * (ห้ามมี fetch ไป host อื่นเด็ดขาด: มีแต่ path สัมพัทธ์ /api/refresh ของเราเอง)
 */
const INLINE_SCRIPT = `
document.querySelectorAll('time[datetime]').forEach(function (el) {
	var d = new Date(el.getAttribute('datetime'));
	if (isNaN(d.getTime())) return;
	// toLocaleString ใช้ timezone ของเครื่องผู้ใช้ ซึ่ง server ไม่มีทางรู้ตอน render
	el.textContent = d.toLocaleString(undefined, {
		year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
	});
});

// ขยายพื้นที่คลิกของแถวโปรเจกต์ให้ทั้งแถว — ตัวลิงก์จริงอยู่ใน <a> ของช่องแรกอยู่แล้ว
// ตรงนี้เป็นแค่ความสะดวก ปิด JS ก็ยัง drill-in ได้ผ่านลิงก์นั้น
document.querySelectorAll('tr.row-link').forEach(function (tr) {
	tr.addEventListener('click', function (ev) {
		// ปล่อยให้ <a> ทำงานเองเวลาคลิกโดนลิงก์ตรงๆ (กันเปิดสองครั้ง / ไม่ทับ ctrl+click)
		if (ev.target.closest('a')) return;
		var href = tr.getAttribute('data-href');
		if (href) location.href = href;
	});
});

var btn = document.getElementById('refresh-btn');
if (btn) {
	btn.addEventListener('click', function () {
		btn.disabled = true;
		var original = btn.textContent;
		btn.textContent = 'กำลังเก็บข้อมูลใหม่...';
		fetch('/api/refresh', { method: 'POST' })
			.then(function (res) { return res.json().catch(function () { return {}; }); })
			.then(function (body) {
				if (body && body.ok === false) {
					alert('เก็บข้อมูลใหม่ไม่สำเร็จ:\\n\\n' + (body.error || 'ไม่ทราบสาเหตุ'));
				}
				location.reload();
			})
			.catch(function (err) {
				btn.disabled = false;
				btn.textContent = original;
				alert('ติดต่อ server ไม่ได้: ' + err);
			});
	});
}
`;

/**
 * ปุ่มสลับ project ↔ ทั้งเครื่อง (M4)
 *
 * เป็นลิงก์ธรรมดาไม่ใช่ปุ่ม JS โดยตั้งใจ: ทำให้ back/forward ของ browser ใช้ได้จริง,
 * bookmark มุมมองที่ต้องการได้, และเปิดคนละแท็บเทียบสองขอบเขตพร้อมกันได้
 * ฝั่ง server ตอบทั้งสอง URL จาก snapshot ก้อนเดิม จึงไม่มีการยิง ccusage ใหม่ตอนสลับ
 */
function renderScopeToggle(data: PageData): string {
	const links = data.scopeLinks;
	if (!links) return '';

	const item = (href: string, label: string, active: boolean, title: string): string =>
		`<a class="toggle-item${active ? ' active' : ''}" href="${escapeHtml(href)}" ` +
		`title="${escapeHtml(title)}"${active ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`;

	return (
		'<div class="scope-toggle" role="group" aria-label="เลือกขอบเขตข้อมูล">' +
		item(links.projectHref, `โปรเจกต์: ${links.projectLabel}`, links.active === 'project', links.projectPath) +
		item(links.allHref, 'ทั้งเครื่อง', links.active === 'all', 'ทุกโปรเจกต์ ทุก agent ในเครื่องนี้') +
		'</div>'
	);
}

export function renderPage(data: PageData): string {
	const { report } = data;

	const scopeBadge =
		report.scope.mode === 'all'
			? '<span class="badge accent">ทั้งเครื่อง</span>'
			: '<span class="badge accent">เฉพาะโปรเจกต์</span>';

	return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ccusage-web — ${escapeHtml(scopeTitle(report))}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
	<header class="page-head">
		<div>
			<h1>ccusage-web</h1>
			<div class="meta">
				${scopeBadge}
				<span class="scope-path">${escapeHtml(scopeTitle(report))}</span>
			</div>
			<div class="meta">ช่วงข้อมูล: ${escapeHtml(dateRangeText(report, data.daily))}</div>
		</div>
		<div class="head-actions">
			${renderScopeToggle(data)}
			<div>
				<button id="refresh-btn" type="button">Refresh</button>
				<div class="meta" style="margin-top:6px">เก็บข้อมูลเมื่อ ${timeTag(data.collectedAt)}</div>
			</div>
		</div>
	</header>

	${renderBanners(data)}
	${renderEmptyState(data)}
	${renderCards(data)}
	${renderChartSection(data)}
	${renderProjectsTable(report)}
	${renderSessionsTable(report)}
	${renderModelsTable(data)}
	${renderUnmapped(report)}

	<footer>
		<div>ตัวเลขทั้งหมดมาจาก <strong>ccusage</strong> โดยตรง — ccusage-web ไม่ได้คำนวณราคาเอง</div>
		<div>binary ที่ใช้: <code>${escapeHtml(data.binary)}</code></div>
		<div>เก็บข้อมูลเมื่อ ${timeTag(data.collectedAt)} · สร้าง report เมื่อ ${timeTag(report.generatedAt)}</div>
		<div>ข้อมูลดิบแบบเต็ม: <a href="/api/report">/api/report</a></div>
	</footer>
</div>
<script>${INLINE_SCRIPT}</script>
</body>
</html>
`;
}
