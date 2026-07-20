/**
 * เทสชั้นเรนเดอร์ — เน้นสองเรื่องที่พังแล้วเจ็บ: escape (XSS) และตัวเลขที่ผู้ใช้จะเอาไปเชื่อ
 *
 * ข้อมูลทั้งหมดในไฟล์นี้เป็น fixture ที่ประกอบขึ้นเอง — **ห้ามแตะ ~/.claude จริง**
 * ทั้งเพราะเทสต้องได้ผลเดิมทุกเครื่อง และเพราะ log จริงเป็นข้อมูลส่วนตัวของผู้ใช้
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderPage, aggregateModels, sessionLabel, MAX_SESSION_ROWS } from '../dist/render/page.js';
import { escapeHtml, money, tokens, compactTokens } from '../dist/render/html.js';
import { renderDailyChart } from '../dist/render/chart.js';

/** payload ที่จงใจให้มีทั้งแท็ก, quote สองแบบ และ ampersand */
const XSS = `<script>alert("x")</script>&'`;

function makeSession(over = {}) {
	return {
		sessionId: '11111111-1111-1111-1111-111111111111',
		agent: 'claude',
		modelsUsed: ['claude-opus-4-8'],
		lastActivity: '2026-07-20T07:16:41.014Z',
		inputTokens: 100,
		outputTokens: 200,
		cacheCreationTokens: 300,
		cacheReadTokens: 400,
		totalTokens: 1000,
		totalCost: 1.5,
		...over,
	};
}

function makeReport(over = {}) {
	const sessions = over.sessions ?? [makeSession()];
	return {
		generatedAt: '2026-07-20T08:00:00.000Z',
		scope: { mode: 'all', matched: true },
		projects: [
			{
				projectPath: '/home/u/proj',
				pathSource: 'cwd',
				pathTrusted: true,
				sessionCount: sessions.length,
				agents: ['claude'],
				models: ['claude-opus-4-8'],
				lastActivity: '2026-07-20T07:16:41.014Z',
				sessions,
				inputTokens: 100,
				outputTokens: 200,
				cacheCreationTokens: 300,
				cacheReadTokens: 400,
				totalTokens: 1000,
				totalCost: 1.5,
			},
		],
		unmapped: {
			sessionCount: 0,
			byReason: { 'agent-not-supported': 0, 'no-log-file': 0 },
			sessions: [],
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			totalTokens: 0,
			totalCost: 0,
		},
		totals: {
			inputTokens: 100,
			outputTokens: 200,
			cacheCreationTokens: 300,
			cacheReadTokens: 400,
			totalTokens: 1000,
			totalCost: 1.5,
		},
		meta: {
			rawTotals: {
				inputTokens: 100,
				outputTokens: 200,
				cacheCreationTokens: 300,
				cacheReadTokens: 400,
				totalTokens: 1000,
				totalCost: 1.5,
			},
			rawSessionCount: sessions.length,
			claudeProjectsDir: '/home/u/.claude/projects',
			claudeProjectsDirExists: true,
			warnings: [],
		},
		...over,
	};
}

function makePageData(over = {}) {
	const report = over.report ?? makeReport();
	return {
		report,
		daily: [
			{
				agent: 'all',
				period: '2026-07-19',
				totalCost: 2,
				totalTokens: 10,
				inputTokens: 1,
				outputTokens: 1,
				cacheCreationTokens: 1,
				cacheReadTokens: 1,
				modelsUsed: [],
				modelBreakdowns: [],
				agents: [{ agent: 'claude', totalCost: 2 }],
			},
			{
				agent: 'all',
				period: '2026-07-20',
				totalCost: 3,
				totalTokens: 10,
				inputTokens: 1,
				outputTokens: 1,
				cacheCreationTokens: 1,
				cacheReadTokens: 1,
				modelsUsed: [],
				modelBreakdowns: [],
				agents: [
					{ agent: 'claude', totalCost: 2 },
					{ agent: 'gemini', totalCost: 1 },
				],
			},
		],
		sessionRows: [
			{
				agent: 'claude',
				period: '11111111-1111-1111-1111-111111111111',
				totalCost: 1.5,
				totalTokens: 1000,
				inputTokens: 100,
				outputTokens: 200,
				cacheCreationTokens: 300,
				cacheReadTokens: 400,
				modelsUsed: ['claude-opus-4-8'],
				modelBreakdowns: [
					{
						modelName: 'claude-opus-4-8',
						inputTokens: 100,
						outputTokens: 200,
						cacheCreationTokens: 300,
						cacheReadTokens: 400,
						cost: 1.5,
					},
				],
			},
		],
		binary: 'bundled dependency (/x/y/ccusage)',
		usedOfflineFallback: false,
		offlineRequested: false,
		collectedAt: '2026-07-20T08:00:00.000Z',
		...over,
	};
}

test('escapeHtml จัดการอักขระอันตรายครบทั้ง 5 ตัว', () => {
	assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
	assert.equal(escapeHtml(undefined), '');
	assert.equal(escapeHtml(null), '');
	// & ต้องถูกแทนก่อนตัวอื่น ไม่งั้นจะได้ &amp;lt; ซ้อน
	assert.equal(escapeHtml('&lt;'), '&amp;lt;');
});

test('XSS: aiTitle ที่มี <script> ต้องถูก escape ไม่หลุดเป็นแท็กจริง', () => {
	const html = renderPage(
		makePageData({ report: makeReport({ sessions: [makeSession({ title: XSS })] }) }),
	);

	assert.ok(!html.includes('<script>alert('), 'ห้ามมีแท็ก script ของ payload หลุดออกมาดิบๆ');
	assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'), 'ต้องเห็น payload ในรูป escape แล้ว');

	// ในหน้าต้องมี <script> ของเราเองแค่ก้อนเดียว (สคริปต์ inline) เท่านั้น
	const scriptOpens = html.match(/<script/g) ?? [];
	assert.equal(scriptOpens.length, 1, 'ต้องมีแท็ก <script> แค่ตัวเดียวคือสคริปต์ inline ของเรา');
});

test('XSS: project path ที่มี quote ต้องไม่ทำให้ attribute แตก', () => {
	const report = makeReport();
	report.projects[0].projectPath = `/home/u/"><img src=x onerror=alert(1)>`;
	const html = renderPage(makePageData({ report }));

	assert.ok(!html.includes('<img src=x'), 'ห้ามมีแท็ก img ที่แทรกมาหลุดออกมา');
	assert.ok(html.includes('&quot;&gt;&lt;img'), 'ต้องเห็น payload ในรูป escape แล้ว');
});

test('XSS: ค่าที่ใส่ใน attribute title= ถูก escape (sessionId + warning)', () => {
	const report = makeReport({ sessions: [makeSession({ sessionId: `a" onmouseover="alert(1)` })] });
	report.meta.warnings = [`เตือน <b>${XSS}</b>`];
	const html = renderPage(makePageData({ report }));

	assert.ok(!html.includes('onmouseover="alert(1)"'), 'attribute ที่แทรกมาต้องไม่กลายเป็น attribute จริง');
	assert.ok(!html.includes('<b><script>'), 'warning ต้องถูก escape ด้วย');
	assert.ok(html.includes('&lt;b&gt;'), 'warning ที่มีแท็กต้องโผล่มาแบบ escape');
});

test('ตัวเลขเงิน 2 ตำแหน่ง + token มีตัวคั่นหลักพัน', () => {
	assert.equal(money(1234.5), '$1,234.50');
	assert.equal(money(0), '$0.00');
	assert.equal(money(2858.978214605001), '$2,858.98');
	assert.equal(money(Number.NaN), '$0.00');
	assert.equal(tokens(1234567), '1,234,567');
	assert.equal(compactTokens(1234567), '1.2M');
	assert.equal(compactTokens(45300), '45.3K');
});

test('ชื่อ session ใช้ aiTitle ถ้ามี ไม่มีค่อย fallback เป็น UUID 8 ตัวแรก', () => {
	assert.equal(sessionLabel(makeSession({ title: 'รีวิวโค้ด' })), 'รีวิวโค้ด');
	assert.equal(sessionLabel(makeSession({ title: '   ' })), '11111111', 'title ที่มีแต่ช่องว่างต้องไม่ชนะ UUID');
	assert.equal(sessionLabel(makeSession()), '11111111');
});

test('session เกิน 200 แถว → ตัดที่ 200 แล้วบอกจำนวนที่ซ่อน', () => {
	const many = Array.from({ length: 250 }, (_, i) =>
		makeSession({
			sessionId: String(i).padStart(8, '0') + '-1111-1111-1111-111111111111',
			title: `งานที่ ${i}`,
		}),
	);
	const html = renderPage(makePageData({ report: makeReport({ sessions: many }) }));

	assert.equal(MAX_SESSION_ROWS, 200);
	assert.ok(html.includes('งานที่ 0'), 'แถวแรกต้องอยู่');
	assert.ok(!html.includes('งานที่ 249'), 'แถวที่เกินเพดานต้องไม่ถูก render');
	assert.ok(html.includes('ซ่อนไว้อีก 50 แถว'), 'ต้องบอกจำนวนแถวที่ซ่อน ไม่ตัดเงียบ');
});

test('หน้าเว็บไม่มี resource ภายนอกเลย (ไม่มี CDN / ไม่มี font นอก / ไม่มี src ออกนอก)', () => {
	const html = renderPage(makePageData());

	// อนุญาตเฉพาะลิงก์ภายในหน้า — ห้ามมี URL ที่ชี้ออกนอกเครื่องทุกรูปแบบ
	assert.ok(!/https?:\/\//i.test(html), 'ห้ามมี http:// หรือ https:// ในหน้า');
	assert.ok(!/src\s*=\s*["']?\/\//.test(html), 'ห้ามมี protocol-relative URL (//cdn...)');
	assert.ok(!/<link\b/i.test(html), 'ห้ามมี <link> ไปโหลด stylesheet/font ภายนอก');
	assert.ok(!/@import/i.test(html), 'ห้ามมี @import ใน CSS');
	assert.ok(!/<script[^>]+src=/i.test(html), 'ห้ามมี <script src=...>');
	assert.ok(html.includes('<style>'), 'CSS ต้อง inline อยู่ในหน้า');
});

test('กราฟเป็น SVG ที่เราเขียนเอง + แยกสีตาม agent', () => {
	const result = renderDailyChart(makePageData().daily);

	assert.ok(result.svg.startsWith('<svg'), 'ต้องเป็น SVG ตรงๆ');
	assert.ok(result.svg.includes('<rect'), 'ต้องมีแท่งกราฟ');
	assert.deepEqual(
		result.colors.map((c) => c.agent),
		['claude', 'gemini'],
		'legend ต้องมี agent ครบและเรียงคงที่',
	);
	assert.notEqual(result.colors[0].color, result.colors[1].color, 'agent คนละตัวต้องคนละสี');
	assert.equal(result.hiddenDays, 0);
});

test('กราฟ: ชื่อ agent แปลกๆ ถูก escape ใน SVG ด้วย', () => {
	const result = renderDailyChart([
		{
			agent: 'all',
			period: '2026-07-20',
			totalCost: 1,
			totalTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			modelsUsed: [],
			modelBreakdowns: [],
			agents: [{ agent: '<b>evil</b>', totalCost: 1 }],
		},
	]);

	assert.ok(!result.svg.includes('<b>evil</b>'), 'ชื่อ agent ต้องไม่หลุดเป็นแท็กใน <title> ของ rect');
	assert.ok(result.svg.includes('&lt;b&gt;evil&lt;/b&gt;'));
});

test('กราฟ: ไม่มีข้อมูลรายวัน → ข้อความว่าง ไม่ throw', () => {
	const result = renderDailyChart([]);
	assert.ok(result.svg.includes('ไม่มีข้อมูล'));
	assert.deepEqual(result.colors, []);
});

test('aggregateModels นับเฉพาะ session ที่อยู่ในขอบเขต', () => {
	const data = makePageData();
	data.sessionRows.push({
		agent: 'claude',
		period: 'session-นอกขอบเขต',
		totalCost: 99,
		totalTokens: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationTokens: 0,
		cacheReadTokens: 0,
		modelsUsed: [],
		modelBreakdowns: [{ modelName: 'claude-opus-4-8', inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 99 }],
	});

	const models = aggregateModels(data.report, data.sessionRows);
	assert.equal(models.length, 1);
	assert.equal(models[0].modelName, 'claude-opus-4-8');
	assert.equal(models[0].cost, 1.5, 'session ที่ไม่อยู่ใน report ห้ามถูกนับ');
});

test('banner เตือนราคา offline ต้องขึ้นเมื่อ usedOfflineFallback = true', () => {
	const off = renderPage(makePageData({ usedOfflineFallback: true }));
	assert.ok(off.includes('ราคานี้มาจากตารางที่ cache ไว้'), 'ต้องมี banner เตือน ห้ามโชว์ราคา cache เงียบๆ');
	assert.ok(off.includes('ดึงตารางราคาจากอินเทอร์เน็ตไม่สำเร็จ'), 'ต้องบอกสาเหตุว่าระบบถอยให้เอง');

	const onlineOnly = renderPage(makePageData());
	assert.ok(!onlineOnly.includes('ราคานี้มาจากตารางที่ cache ไว้'), 'ตอนราคาปกติต้องไม่มี banner');

	// ผู้ใช้สั่ง --offline เอง → ยังต้องเตือน แต่บอกสาเหตุคนละแบบ
	const asked = renderPage(makePageData({ usedOfflineFallback: true, offlineRequested: true }));
	assert.ok(asked.includes('คุณสั่ง'), 'ต้องบอกว่าเป็นเพราะผู้ใช้สั่งเอง');
});

test('unmapped ต้องโชว์เสมอ ห้ามซ่อน', () => {
	const report = makeReport();
	report.unmapped = {
		sessionCount: 2,
		byReason: { 'agent-not-supported': 2, 'no-log-file': 0 },
		sessions: [
			{ ...makeSession({ agent: 'gemini', sessionId: 'aaaaaaaa-x' }), reason: 'agent-not-supported', reasonText: 'agent นี้ไม่ได้เก็บ log แยกต่อ session' },
			{ ...makeSession({ agent: 'gemini', sessionId: 'bbbbbbbb-x' }), reason: 'agent-not-supported', reasonText: 'agent นี้ไม่ได้เก็บ log แยกต่อ session' },
		],
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationTokens: 0,
		cacheReadTokens: 0,
		totalTokens: 0,
		totalCost: 12.34,
	};

	const html = renderPage(makePageData({ report }));
	assert.ok(html.includes('ระบุโปรเจกต์ไม่ได้'), 'ต้องมี section unmapped');
	assert.ok(html.includes('$12.34'), 'ต้องโชว์ยอด cost ของ unmapped');
});

test('pathTrusted=false ต้องมีป้ายเตือนบนหน้า', () => {
	const report = makeReport();
	report.projects[0].pathTrusted = false;
	report.projects[0].pathSource = 'dir-name';
	const html = renderPage(makePageData({ report }));

	assert.ok(html.includes('path เดาจากชื่อโฟลเดอร์'), 'ต้องติดป้ายที่แถวโปรเจกต์');
	assert.ok(html.includes('มี path ที่เดามาจากชื่อโฟลเดอร์'), 'ต้องมี banner สรุปด้วย');
});

test('โหมด project ที่หาไม่เจอ → หน้าไม่พัง + บอกทางออก', () => {
	const report = makeReport({
		scope: { mode: 'project', requestedPath: '/tmp/x', resolvedPath: '/tmp/x', matched: false },
		projects: [],
	});
	const html = renderPage(makePageData({ report }));

	assert.ok(html.includes('ยังไม่มีข้อมูล usage ของ'), 'ต้องมี banner บอกว่าไม่เจอ');
	assert.ok(html.includes('ccusage-web --all'), 'ต้องบอกทางออก');
	// โหมดเจาะโปรเจกต์ต้องกำกับว่ากราฟรายวันยังเป็นยอดทั้งเครื่อง
	assert.ok(html.includes('ccusage ไม่ได้แยกยอดรายวันต่อโปรเจกต์'));
});
