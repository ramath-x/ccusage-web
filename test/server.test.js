/**
 * เทส server — ยิง HTTP จริงแต่ **ไม่แตะ ccusage และไม่แตะ ~/.claude**
 * collector ถูกส่งเข้ามาเป็นฟังก์ชันปลอม จึงคุมผลลัพธ์และจังหวะเวลาได้เต็มที่
 *
 * ทุกเคสใช้ port 0 (ให้ OS เลือก) — **ห้ามผูก port ตายตัว** เพราะเทสอาจรันขนานกับ
 * dev server ของเครื่องนั้น แล้วจะ fail แบบสุ่มด้วยเหตุผลที่ไม่เกี่ยวกับโค้ดเลย
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer, HOST } from '../dist/server.js';

function makePageData(over = {}) {
	const totals = {
		inputTokens: 1,
		outputTokens: 2,
		cacheCreationTokens: 3,
		cacheReadTokens: 4,
		totalTokens: 1234567,
		totalCost: 2858.978214605001,
	};
	return {
		report: {
			generatedAt: '2026-07-20T08:00:00.000Z',
			scope: { mode: 'all', matched: true },
			projects: [
				{
					projectPath: '/home/u/proj',
					pathSource: 'cwd',
					pathTrusted: true,
					sessionCount: 1,
					agents: ['claude'],
					models: ['claude-opus-4-8'],
					lastActivity: '2026-07-20T07:16:41.014Z',
					sessions: [
						{
							sessionId: '11111111-1111-1111-1111-111111111111',
							agent: 'claude',
							title: 'งานทดสอบ',
							modelsUsed: ['claude-opus-4-8'],
							lastActivity: '2026-07-20T07:16:41.014Z',
							...totals,
						},
					],
					...totals,
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
			totals,
			meta: {
				rawTotals: totals,
				rawSessionCount: 1,
				claudeProjectsDir: '/home/u/.claude/projects',
				claudeProjectsDirExists: true,
				warnings: [],
			},
		},
		daily: [],
		sessionRows: [],
		binary: 'fake',
		usedOfflineFallback: false,
		offlineRequested: false,
		collectedAt: '2026-07-20T08:00:00.000Z',
		...over,
	};
}

/** เปิด server + คืน helper ที่ปิดให้อัตโนมัติท้ายเคส */
async function withServer(t, options) {
	const running = await startServer(options);
	t.after(() => running.close());
	return running;
}

test('bind 127.0.0.1 และได้ port ว่างอัตโนมัติ', async (t) => {
	const running = await withServer(t, { initial: makePageData(), collect: async () => makePageData() });

	assert.ok(running.port > 0, 'ต้องได้ port จริงจาก OS');
	assert.equal(running.url, `http://${HOST}:${running.port}`);
	assert.equal(HOST, '127.0.0.1', 'ห้าม bind 0.0.0.0 — ข้อมูล cost ต้องไม่ออกนอกเครื่อง');
});

test('เปิดสองตัวพร้อมกันต้องได้คนละ port ไม่ชนกัน', async (t) => {
	const a = await withServer(t, { initial: makePageData(), collect: async () => makePageData() });
	const b = await withServer(t, { initial: makePageData(), collect: async () => makePageData() });

	assert.notEqual(a.port, b.port);
	// ทั้งคู่ต้องยังตอบได้จริง ไม่ใช่แค่ listen ผ่าน
	for (const server of [a, b]) {
		const res = await fetch(`${server.url}/api/report`);
		assert.equal(res.status, 200);
	}
});

test('--port ที่ถูกใช้อยู่ → error ทันที ไม่แอบเลื่อนไป port อื่น', async (t) => {
	const first = await withServer(t, { initial: makePageData(), collect: async () => makePageData() });

	await assert.rejects(
		() => startServer({ initial: makePageData(), collect: async () => makePageData(), port: first.port }),
		(err) => {
			assert.match(err.message, /ถูกใช้งานอยู่แล้ว/, 'ต้องบอกตรงๆ ว่า port ชน');
			assert.match(err.message, new RegExp(String(first.port)), 'ต้องบอกว่า port ไหนที่ชน');
			return true;
		},
	);
});

test('GET / → 200 text/html และตัวเลขตรงกับ /api/report', async (t) => {
	const running = await withServer(t, { initial: makePageData(), collect: async () => makePageData() });

	const page = await fetch(`${running.url}/`);
	assert.equal(page.status, 200);
	assert.match(page.headers.get('content-type'), /text\/html/);
	const html = await page.text();
	assert.ok(html.startsWith('<!doctype html>'));

	const api = await fetch(`${running.url}/api/report`);
	assert.equal(api.status, 200);
	assert.match(api.headers.get('content-type'), /application\/json/);
	const json = await api.json();

	// ตัวเลขที่ผู้ใช้เห็นบนหน้าต้องเป็นตัวเดียวกับใน JSON — คนละตัวเมื่อไหร่ = เลิกเชื่อทั้งหน้า
	const expected = `$${json.report.totals.totalCost.toLocaleString('en-US', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
	assert.equal(expected, '$2,858.98');
	assert.ok(html.includes(expected), `หน้า HTML ต้องมี ${expected}`);
	assert.ok(html.includes('1,234,567'), 'token รวมต้องมีตัวคั่นหลักพัน');
});

test('/api/refresh เก็บข้อมูลใหม่แล้วอัปเดต snapshot', async (t) => {
	let round = 0;
	const running = await withServer(t, {
		initial: makePageData({ collectedAt: 'รอบแรก' }),
		collect: async () => {
			round += 1;
			return makePageData({ collectedAt: `รอบที่ ${round}` });
		},
	});

	const before = await (await fetch(`${running.url}/api/report`)).json();
	assert.equal(before.meta.collectedAt, 'รอบแรก');

	const refreshed = await fetch(`${running.url}/api/refresh`, { method: 'POST' });
	assert.equal(refreshed.status, 200);
	assert.equal((await refreshed.json()).ok, true);

	const after = await (await fetch(`${running.url}/api/report`)).json();
	assert.equal(after.meta.collectedAt, 'รอบที่ 1');

	// GET ก็ต้องใช้ได้ (เรียกมือจาก curl)
	assert.equal((await fetch(`${running.url}/api/refresh`)).status, 200);
	assert.equal(round, 2);
});

test('กด Refresh รัวๆ ต้องไม่ spawn collector ซ้อน (reuse promise เดิม)', async (t) => {
	let started = 0;
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});

	const running = await withServer(t, {
		initial: makePageData(),
		collect: async () => {
			started += 1;
			await gate; // ค้างไว้จนกว่าเทสจะปล่อย = จำลอง ccusage ที่ยังรันไม่เสร็จ
			return makePageData({ collectedAt: `เก็บครั้งที่ ${started}` });
		},
	});

	// ยิง 5 คำขอตอน collector ยังค้างอยู่
	const inflight = Array.from({ length: 5 }, () => fetch(`${running.url}/api/refresh`, { method: 'POST' }));
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(started, 1, 'ห้ามเรียก collector มากกว่า 1 ครั้งขณะที่ยังรันค้างอยู่');

	release();
	const results = await Promise.all(inflight);
	for (const res of results) assert.equal(res.status, 200);
	assert.equal(started, 1);

	// รอบถัดไปหลังรอบเดิมจบแล้ว ต้องเก็บใหม่จริง ไม่ใช่คืนของเดิมค้าง
	await fetch(`${running.url}/api/refresh`, { method: 'POST' });
	assert.equal(started, 2);
});

test('collector พัง → 503 + snapshot เดิมยังเสิร์ฟได้ + หน้าเว็บบอกว่าเก่า', async (t) => {
	const running = await withServer(t, {
		initial: makePageData(),
		collect: async () => {
			throw new Error('ccusage ระเบิด');
		},
	});

	const res = await fetch(`${running.url}/api/refresh`, { method: 'POST' });
	assert.equal(res.status, 503, 'เก็บใหม่ไม่ได้แต่ของเดิมยังเสิร์ฟได้ → 503 ไม่ใช่ 500');
	const body = await res.json();
	assert.equal(body.ok, false);
	assert.match(body.error, /ระเบิด/);

	const page = await fetch(`${running.url}/`);
	assert.equal(page.status, 200, 'หน้าเว็บต้องยังใช้ได้ ห้าม 500');
	const html = await page.text();
	assert.ok(html.includes('Refresh ล่าสุดไม่สำเร็จ'), 'ต้องบอกผู้ใช้ว่าข้อมูลที่เห็นเป็นชุดเก่า');
});

test('path มั่ว → 404, method ผิด → 405', async (t) => {
	const running = await withServer(t, { initial: makePageData(), collect: async () => makePageData() });

	const notFound = await fetch(`${running.url}/ไม่มีหน้านี้`);
	assert.equal(notFound.status, 404);

	const wrongMethod = await fetch(`${running.url}/`, { method: 'DELETE' });
	assert.equal(wrongMethod.status, 405);
	assert.match(wrongMethod.headers.get('allow'), /GET/);

	const apiWrongMethod = await fetch(`${running.url}/api/report`, { method: 'POST' });
	assert.equal(apiWrongMethod.status, 405);
});

test('header กันหน้าโหลด resource ภายนอก (CSP) ติดมาด้วย', async (t) => {
	const running = await withServer(t, { initial: makePageData(), collect: async () => makePageData() });

	const res = await fetch(`${running.url}/`);
	const csp = res.headers.get('content-security-policy');
	assert.match(csp, /default-src 'none'/, 'CSP ต้องปิดการโหลดจากภายนอกเป็นค่าเริ่มต้น');
	assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
	assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('query string ต่อท้าย path ต้องไม่ทำให้ route หลุดไป 404', async (t) => {
	const running = await withServer(t, { initial: makePageData(), collect: async () => makePageData() });
	assert.equal((await fetch(`${running.url}/?x=1`)).status, 200);
	assert.equal((await fetch(`${running.url}/api/report?y=2`)).status, 200);
});

test('close() แล้ว port ต้องถูกปล่อยจริง (เปิดซ้ำที่ port เดิมได้)', async () => {
	const first = await startServer({ initial: makePageData(), collect: async () => makePageData() });
	const port = first.port;
	await first.close();

	// ถ้า close() ไม่สะอาด ตรงนี้จะโยน EADDRINUSE
	const second = await startServer({ initial: makePageData(), collect: async () => makePageData(), port });
	assert.equal(second.port, port);
	await second.close();
});
