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
import { buildPayload, buildView } from '../dist/snapshot.js';

const PROJECT_A = '/home/u/proj-a';
const PROJECT_B = '/home/u/proj-b';

function sessionRow(period, over = {}) {
	return {
		agent: 'claude',
		period,
		inputTokens: 1,
		outputTokens: 2,
		cacheCreationTokens: 3,
		cacheReadTokens: 4,
		totalTokens: 1234567,
		totalCost: 2858.978214605001,
		modelsUsed: ['claude-opus-4-8'],
		modelBreakdowns: [],
		metadata: { lastActivity: '2026-07-20T07:16:41.014Z' },
		...over,
	};
}

/**
 * snapshot = **ข้อมูลดิบ** ไม่ใช่ report สำเร็จรูป (เปลี่ยนตอน M4)
 *
 * เดิม fixture ประกอบ `report` มาให้เสร็จแล้วยัดใส่ server ตรงๆ ซึ่งใช้ไม่ได้อีกต่อไป
 * เพราะตอนนี้ server ต้องประกอบ report เองต่อ request ตาม scope ที่ URL ขอ —
 * ถ้า fixture ยังส่ง report สำเร็จรูปมา เทสจะไม่ได้ทดสอบเส้นทางจริงที่ผู้ใช้เจอเลย
 */
function makeSnapshot(over = {}) {
	const index = {
		rootDir: '/home/u/.claude/projects',
		rootExists: true,
		warnings: [],
		sessions: new Map([
			[
				'11111111-1111-1111-1111-111111111111',
				{
					sessionId: '11111111-1111-1111-1111-111111111111',
					projectPath: PROJECT_A,
					pathSource: 'cwd',
					pathTrusted: true,
					title: 'งานทดสอบ',
				},
			],
			[
				'22222222-2222-2222-2222-222222222222',
				{
					sessionId: '22222222-2222-2222-2222-222222222222',
					projectPath: PROJECT_B,
					pathSource: 'cwd',
					pathTrusted: true,
					title: 'งานอีกโปรเจกต์',
				},
			],
		]),
	};

	return {
		sessionRows: [
			sessionRow('11111111-1111-1111-1111-111111111111'),
			sessionRow('22222222-2222-2222-2222-222222222222', { totalCost: 10, totalTokens: 500 }),
		],
		daily: [],
		index,
		binary: 'fake',
		usedOfflineFallback: false,
		offlineRequested: false,
		collectedAt: '2026-07-20T08:00:00.000Z',
		defaultScope: { mode: 'all' },
		projectTogglePath: PROJECT_A,
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
	const running = await withServer(t, { initial: makeSnapshot(), collect: async () => makeSnapshot() });

	assert.ok(running.port > 0, 'ต้องได้ port จริงจาก OS');
	assert.equal(running.url, `http://${HOST}:${running.port}`);
	assert.equal(HOST, '127.0.0.1', 'ห้าม bind 0.0.0.0 — ข้อมูล cost ต้องไม่ออกนอกเครื่อง');
});

test('เปิดสองตัวพร้อมกันต้องได้คนละ port ไม่ชนกัน', async (t) => {
	const a = await withServer(t, { initial: makeSnapshot(), collect: async () => makeSnapshot() });
	const b = await withServer(t, { initial: makeSnapshot(), collect: async () => makeSnapshot() });

	assert.notEqual(a.port, b.port);
	// ทั้งคู่ต้องยังตอบได้จริง ไม่ใช่แค่ listen ผ่าน
	for (const server of [a, b]) {
		const res = await fetch(`${server.url}/api/report`);
		assert.equal(res.status, 200);
	}
});

test('--port ที่ถูกใช้อยู่ → error ทันที ไม่แอบเลื่อนไป port อื่น', async (t) => {
	const first = await withServer(t, { initial: makeSnapshot(), collect: async () => makeSnapshot() });

	await assert.rejects(
		() => startServer({ initial: makeSnapshot(), collect: async () => makeSnapshot(), port: first.port }),
		(err) => {
			assert.match(err.message, /ถูกใช้งานอยู่แล้ว/, 'ต้องบอกตรงๆ ว่า port ชน');
			assert.match(err.message, new RegExp(String(first.port)), 'ต้องบอกว่า port ไหนที่ชน');
			return true;
		},
	);
});

test('GET / → 200 text/html และตัวเลขตรงกับ /api/report', async (t) => {
	const running = await withServer(t, { initial: makeSnapshot(), collect: async () => makeSnapshot() });

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
	// (`json.totals` ไม่ใช่ `json.report.totals` แล้ว — /api/report ถูกทำให้แบนเท่ากับ `--json`)
	const expected = `$${json.totals.totalCost.toLocaleString('en-US', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
	// fixture มี 2 โปรเจกต์ (ไว้เทส drill-in) ยอดรวมโหมดทั้งเครื่องจึงเป็นผลบวกของทั้งคู่
	// = 2,858.978... + 10 — เลขนี้ถูก server บวกเองจาก session ดิบ ไม่ใช่ค่าที่ fixture ป้อนมาสำเร็จรูป
	assert.equal(expected, '$2,868.98');
	assert.ok(html.includes(expected), `หน้า HTML ต้องมี ${expected}`);
	assert.ok(html.includes('1,235,067'), 'token รวมต้องมีตัวคั่นหลักพัน');
	assert.ok(html.includes('1,234,567'), 'ตาราง session ต้องโชว์ token ของแถวแบบเต็ม');
});

test('/api/refresh เก็บข้อมูลใหม่แล้วอัปเดต snapshot', async (t) => {
	let round = 0;
	const running = await withServer(t, {
		initial: makeSnapshot({ collectedAt: 'รอบแรก' }),
		collect: async () => {
			round += 1;
			return makeSnapshot({ collectedAt: `รอบที่ ${round}` });
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
		initial: makeSnapshot(),
		collect: async () => {
			started += 1;
			await gate; // ค้างไว้จนกว่าเทสจะปล่อย = จำลอง ccusage ที่ยังรันไม่เสร็จ
			return makeSnapshot({ collectedAt: `เก็บครั้งที่ ${started}` });
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
		initial: makeSnapshot(),
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
	const running = await withServer(t, { initial: makeSnapshot(), collect: async () => makeSnapshot() });

	const notFound = await fetch(`${running.url}/ไม่มีหน้านี้`);
	assert.equal(notFound.status, 404);

	const wrongMethod = await fetch(`${running.url}/`, { method: 'DELETE' });
	assert.equal(wrongMethod.status, 405);
	assert.match(wrongMethod.headers.get('allow'), /GET/);

	const apiWrongMethod = await fetch(`${running.url}/api/report`, { method: 'POST' });
	assert.equal(apiWrongMethod.status, 405);
});

test('header กันหน้าโหลด resource ภายนอก (CSP) ติดมาด้วย', async (t) => {
	const running = await withServer(t, { initial: makeSnapshot(), collect: async () => makeSnapshot() });

	const res = await fetch(`${running.url}/`);
	const csp = res.headers.get('content-security-policy');
	assert.match(csp, /default-src 'none'/, 'CSP ต้องปิดการโหลดจากภายนอกเป็นค่าเริ่มต้น');
	assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
	assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('query string ต่อท้าย path ต้องไม่ทำให้ route หลุดไป 404', async (t) => {
	const running = await withServer(t, { initial: makeSnapshot(), collect: async () => makeSnapshot() });
	assert.equal((await fetch(`${running.url}/?x=1`)).status, 200);
	assert.equal((await fetch(`${running.url}/api/report?y=2`)).status, 200);
});

/* ───────────────────────── M4: สลับ scope / drill-in / empty state ───────────────────────── */

test('สลับ scope ไปกลับหลายรอบ ต้องไม่เรียก collector (= ไม่ยิง ccusage) เลยสักครั้ง', async (t) => {
	// collector คือ **จุดเดียว** ในระบบที่ spawn ccusage — นับจำนวนครั้งที่ถูกเรียกจึงเท่ากับ
	// นับจำนวน process ccusage ที่เกิดขึ้น ถ้าเลขนี้เป็น 0 แปลว่าสลับ scope ไม่แตะ ccusage แน่นอน
	let collectorCalls = 0;
	const running = await withServer(t, {
		initial: makeSnapshot(),
		collect: async () => {
			collectorCalls += 1;
			return makeSnapshot();
		},
	});

	const urls = [
		`${running.url}/?scope=all`,
		`${running.url}/?project=${encodeURIComponent(PROJECT_A)}`,
		`${running.url}/?scope=all`,
		`${running.url}/?project=${encodeURIComponent(PROJECT_B)}`,
		`${running.url}/?scope=project`,
		`${running.url}/api/report?scope=all`,
		`${running.url}/api/report?project=${encodeURIComponent(PROJECT_A)}`,
	];
	for (const url of urls) {
		const res = await fetch(url);
		assert.equal(res.status, 200, `${url} ต้องได้ 200`);
	}

	assert.equal(collectorCalls, 0, 'สลับ scope ห้ามยิง collector/ccusage ใหม่แม้แต่ครั้งเดียว');
});

test('?scope=all ↔ ?project=... ให้ตัวเลขคนละชุดจากข้อมูลดิบก้อนเดียวกัน', async (t) => {
	const running = await withServer(t, { initial: makeSnapshot(), collect: async () => makeSnapshot() });

	const all = await (await fetch(`${running.url}/api/report?scope=all`)).json();
	assert.equal(all.scope.mode, 'all');
	assert.equal(all.projects.length, 2);
	assert.ok(Math.abs(all.totals.totalCost - 2868.978214605001) < 1e-9);

	const projectB = await (
		await fetch(`${running.url}/api/report?project=${encodeURIComponent(PROJECT_B)}`)
	).json();
	assert.equal(projectB.scope.mode, 'project');
	assert.equal(projectB.scope.matched, true);
	assert.equal(projectB.projects.length, 1, 'โหมดเจาะต้องเหลือโปรเจกต์เดียว');
	assert.equal(projectB.projects[0].projectPath, PROJECT_B);
	assert.equal(projectB.totals.totalCost, 10, 'ยอดต้องเป็นของโปรเจกต์นั้นเท่านั้น');

	// meta.rawTotals เป็นยอดก่อนกรอง scope — ต้องเท่ากันทั้งสองมุมมองเพราะเป็นข้อมูลดิบชุดเดียวกัน
	assert.deepEqual(all.meta.rawTotals, projectB.meta.rawTotals);
	assert.equal(all.meta.collectedAt, projectB.meta.collectedAt);
});

test('drill-in: หน้าโหมดทั้งเครื่องต้องมีลิงก์เจาะไปแต่ละโปรเจกต์ + toggle สลับกลับ', async (t) => {
	const running = await withServer(t, { initial: makeSnapshot(), collect: async () => makeSnapshot() });

	const html = await (await fetch(`${running.url}/?scope=all`)).text();
	assert.ok(
		html.includes(`href="/?project=${encodeURIComponent(PROJECT_A)}"`),
		'ตารางโปรเจกต์ต้องมีลิงก์ drill-in ของ A',
	);
	assert.ok(html.includes(`href="/?project=${encodeURIComponent(PROJECT_B)}"`), 'และของ B');
	assert.ok(html.includes('href="/?scope=all"'), 'ต้องมีลิงก์กลับไปโหมดทั้งเครื่อง');

	// ลิงก์ที่หน้าโชว์ต้องใช้ได้จริง ไม่ใช่แค่มีอยู่
	const drilled = await fetch(`${running.url}/?project=${encodeURIComponent(PROJECT_B)}`);
	assert.equal(drilled.status, 200);
	const drilledHtml = await drilled.text();
	assert.ok(drilledHtml.includes('เฉพาะโปรเจกต์'), 'หน้าที่เจาะแล้วต้องติดป้ายว่าเป็นขอบเขตโปรเจกต์');
	assert.ok(!drilledHtml.includes('งานทดสอบ'), 'session ของโปรเจกต์อื่นต้องไม่ติดมาด้วย');
});

test('empty state: path ที่ไม่ตรงโปรเจกต์ไหนเลย → 200 + ปุ่มดูทั้งเครื่อง ไม่ error', async (t) => {
	const running = await withServer(t, { initial: makeSnapshot(), collect: async () => makeSnapshot() });

	const res = await fetch(`${running.url}/?project=${encodeURIComponent('/tmp/ไม่มีอยู่จริง')}`);
	assert.equal(res.status, 200, 'ยืนอยู่ในโฟลเดอร์ที่ไม่เคยใช้ agent = ผลว่าง ไม่ใช่ error');
	const html = await res.text();
	assert.ok(html.includes('ยังไม่มีข้อมูลของโฟลเดอร์นี้'), 'ต้องมี empty state');
	assert.ok(html.includes('ดูทั้งเครื่องแทน'), 'ต้องมีทางออกให้กด');
	assert.ok(html.includes('href="/?scope=all"'), 'ปุ่มต้องเป็นลิงก์ที่กดแล้วไปได้จริง');

	const json = await (
		await fetch(`${running.url}/api/report?project=${encodeURIComponent('/tmp/ไม่มีอยู่จริง')}`)
	).json();
	assert.equal(json.scope.matched, false);
	assert.deepEqual(json.projects, []);
	assert.equal(json.totals.totalCost, 0);
});

test('/api/report คืนโครงเดียวกับที่ `--json` พิมพ์ออก stdout เป๊ะ', async (t) => {
	const snapshot = makeSnapshot();
	const running = await withServer(t, { initial: snapshot, collect: async () => snapshot });

	// cli.ts พิมพ์ `JSON.stringify(buildPayload(buildView(snapshot, scope)))` ตรงๆ
	// เทียบกับสิ่งที่ endpoint คืน = พิสูจน์ว่าสองทางออกใช้โครงเดียวกันจริง ไม่ใช่แค่หน้าตาคล้าย
	const fromCli = JSON.parse(JSON.stringify(buildPayload(buildView(snapshot, { mode: 'all' }))));
	const fromApi = await (await fetch(`${running.url}/api/report?scope=all`)).json();

	assert.deepEqual(Object.keys(fromApi).sort(), Object.keys(fromCli).sort());

	// generatedAt = "เวลาที่ประกอบ report ก้อนนี้" ซึ่งต่างกันระดับมิลลิวินาทีตามธรรมชาติ
	// (คนละ request คนละจังหวะ) — เทียบว่าเป็น ISO ที่ใช้ได้ก็พอ ที่เหลือต้องตรงเป๊ะ
	assert.match(fromApi.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
	assert.deepEqual({ ...fromApi, generatedAt: 'x' }, { ...fromCli, generatedAt: 'x' });

	// key ที่สคริปต์ภายนอกจะอ่าน — ล็อกไว้กันเผลอเปลี่ยนหลัง publish
	assert.deepEqual(Object.keys(fromApi).sort(), [
		'daily',
		'generatedAt',
		'meta',
		'projects',
		'scope',
		'totals',
		'unmapped',
	]);
	assert.equal(fromApi.meta.dailyScope, 'machine', 'ต้องประกาศว่ายอดรายวันเป็นของทั้งเครื่อง');
	assert.equal(fromApi.meta.binary, 'fake');
});

test('close() แล้ว port ต้องถูกปล่อยจริง (เปิดซ้ำที่ port เดิมได้)', async () => {
	const first = await startServer({ initial: makeSnapshot(), collect: async () => makeSnapshot() });
	const port = first.port;
	await first.close();

	// ถ้า close() ไม่สะอาด ตรงนี้จะโยน EADDRINUSE
	const second = await startServer({ initial: makeSnapshot(), collect: async () => makeSnapshot(), port });
	assert.equal(second.port, port);
	await second.close();
});
