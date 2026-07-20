/**
 * เทสของ report model — เน้นกติกาเดียวที่ห้ามพลาด:
 * ทุก session ต้องมีที่ไป และยอดรวมต้องไม่หายระหว่าง join (PLAN M2 เกณฑ์ผ่าน)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildProjectIndex, clearProjectIndexCache } from '../dist/projects.js';
import { buildReport, normalizePath } from '../dist/report.js';

const FIXTURE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'projects');

/**
 * เทียบเงินด้วย epsilon ไม่ใช่ ===
 * การบวก float หลายร้อยครั้งทำให้ผลต่างระดับ 1e-13 เป็นเรื่องปกติของ IEEE-754
 * ไม่ใช่สัญญาณว่า join พัง — ถ้า join พังจริงส่วนต่างจะเป็นหน่วยดอลลาร์
 */
function assertMoneyEqual(actual, expected, message) {
	assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ได้ ${actual} คาดว่า ${expected}`);
}

function row(overrides) {
	return {
		agent: 'claude',
		period: 'x',
		inputTokens: 10,
		outputTokens: 20,
		cacheCreationTokens: 30,
		cacheReadTokens: 40,
		totalTokens: 100,
		totalCost: 1,
		modelsUsed: ['claude-opus-4-8'],
		modelBreakdowns: [],
		...overrides,
	};
}

const SESSIONS = [
	row({ period: '11111111-1111-1111-1111-111111111111', totalCost: 12.5, metadata: { lastActivity: '2026-07-01T00:00:00.000Z' } }),
	row({ period: '22222222-2222-2222-2222-222222222222', totalCost: 7.25, metadata: { lastActivity: '2026-07-05T00:00:00.000Z' } }),
	row({ period: '44444444-4444-4444-4444-444444444444', totalCost: 30.5, metadata: { lastActivity: '2026-06-01T00:00:00.000Z' } }),
	// ไม่มีไฟล์ log ในเครื่อง → ต้องเข้า unmapped ด้วยเหตุผล no-log-file
	row({ period: 'deaddead-0000-0000-0000-000000000000', totalCost: 3 }),
	// gemini ไม่มี metadata เลย และ map โปรเจกต์ไม่ได้ตามนิยาม
	row({ agent: 'gemini', period: 'beefbeef-0000-0000-0000-000000000000', totalCost: 2.75, metadata: undefined }),
];

async function loadIndex() {
	clearProjectIndexCache();
	return buildProjectIndex({ rootDir: FIXTURE_ROOT });
}

test('Σ cost ทุก project + Σ cost unmapped == Σ cost ดิบ (เกณฑ์ผ่าน M2)', async () => {
	const index = await loadIndex();
	const report = buildReport(SESSIONS, index, { scope: { mode: 'all' } });

	const rawCost = SESSIONS.reduce((sum, r) => sum + r.totalCost, 0);
	const projectCost = report.projects.reduce((sum, p) => sum + p.totalCost, 0);

	assertMoneyEqual(projectCost + report.unmapped.totalCost, rawCost, 'ยอดรวมหลัง join ต้องไม่หาย');
	assertMoneyEqual(report.totals.totalCost, rawCost, 'totals ในโหมด --all ต้องเท่ายอดดิบ');
	assertMoneyEqual(report.meta.rawTotals.totalCost, rawCost, 'rawTotals ต้องเท่ายอดดิบ');

	const grouped = report.projects.reduce((sum, p) => sum + p.sessionCount, 0) + report.unmapped.sessionCount;
	assert.equal(grouped, SESSIONS.length, 'จำนวน session ต้องครบ ไม่มีตัวไหนหายเงียบ');

	// token ก็ต้องไม่หายเหมือนกัน ไม่ใช่แค่เงิน
	const rawTokens = SESSIONS.reduce((sum, r) => sum + r.totalTokens, 0);
	assert.equal(report.totals.totalTokens, rawTokens);
});

test('session ที่ join ไม่ติดต้องเข้า unmapped พร้อมเหตุผล ห้ามทิ้งเงียบ', async () => {
	const index = await loadIndex();
	const report = buildReport(SESSIONS, index, { scope: { mode: 'all' } });

	assert.equal(report.unmapped.sessionCount, 2);
	assert.deepEqual(report.unmapped.byReason, { 'agent-not-supported': 1, 'no-log-file': 1 });
	assertMoneyEqual(report.unmapped.totalCost, 3 + 2.75, 'unmapped ต้องรวมยอดของทั้งสองเคส');

	const gemini = report.unmapped.sessions.find((s) => s.agent === 'gemini');
	assert.equal(gemini.reason, 'agent-not-supported');
	assert.ok(gemini.reasonText.length > 0, 'ต้องมีข้อความอธิบายให้ user อ่าน');
	assert.equal(gemini.lastActivity, undefined, 'ไม่มี lastActivity ต้องเป็น undefined ไม่ใช่ crash');
});

test('จัดกลุ่มตามโปรเจกต์ถูกต้อง + เรียงตาม cost มาก→น้อย', async () => {
	const index = await loadIndex();
	const report = buildReport(SESSIONS, index, { scope: { mode: 'all' } });

	assert.deepEqual(
		report.projects.map((p) => p.projectPath),
		[normalizePath('/home/user/ghost'), normalizePath('/home/user/my-cool-app')],
		'ghost ($30.50) ต้องมาก่อน my-cool-app ($19.75)',
	);

	const cool = report.projects.find((p) => p.projectPath === normalizePath('/home/user/my-cool-app'));
	assert.equal(cool.sessionCount, 2, 'สอง session ที่ cwd เดียวกันต้องรวมเป็นโปรเจกต์เดียว');
	assertMoneyEqual(cool.totalCost, 19.75, 'cost ต่อโปรเจกต์');
	assert.equal(cool.lastActivity, '2026-07-05T00:00:00.000Z', 'lastActivity ของโปรเจกต์ = ตัวล่าสุดของ session');
	assert.deepEqual(cool.agents, ['claude']);
	assert.equal(cool.sessions[0].title, 'session ที่ cwd อยู่ลึกเกินหัวไฟล์', 'เรียง session ใหม่→เก่า');

	const ghost = report.projects.find((p) => p.projectPath === normalizePath('/home/user/ghost'));
	assert.equal(ghost.pathTrusted, false, 'โปรเจกต์ที่เดา path มาต้องติดธงไว้');
});

test('โหมด project กรองเฉพาะโปรเจกต์นั้น และ path เทียบแบบ normalize', async () => {
	const index = await loadIndex();
	// ใส่ trailing slash + `..` เพื่อพิสูจน์ว่าไม่ได้เทียบ string ดิบ
	const report = buildReport(SESSIONS, index, {
		scope: { mode: 'project', targetPath: '/home/user/ghost/../my-cool-app/' },
	});

	assert.equal(report.scope.matched, true);
	assert.equal(report.scope.resolvedPath, normalizePath('/home/user/my-cool-app'));
	assert.equal(report.projects.length, 1);
	assertMoneyEqual(report.totals.totalCost, 19.75, 'โหมด project ไม่รวม unmapped เข้ายอด');
	assert.equal(report.unmapped.sessionCount, 2, 'แต่ยังโชว์ unmapped ให้เห็นอยู่');
});

test('path ที่ไม่ตรงโปรเจกต์ไหนเลย → ผลว่าง ไม่ throw', async () => {
	const index = await loadIndex();
	const report = buildReport(SESSIONS, index, {
		scope: { mode: 'project', targetPath: '/home/user/ไม่เคยใช้ที่นี่' },
	});

	assert.equal(report.scope.matched, false);
	assert.deepEqual(report.projects, []);
	assertMoneyEqual(report.totals.totalCost, 0, 'ยอดต้องเป็น 0 ไม่ใช่ NaN');
	assert.equal(report.meta.rawSessionCount, SESSIONS.length, 'ยังบอกได้ว่าทั้งเครื่องมีกี่ session');
});

test('ไม่มี ~/.claude/projects → ทุก session เข้า unmapped ยอดยังตรง', async () => {
	clearProjectIndexCache();
	const index = await buildProjectIndex({ rootDir: path.join(FIXTURE_ROOT, 'ไม่มีอยู่จริง') });
	const report = buildReport(SESSIONS, index, { scope: { mode: 'all' } });

	assert.equal(report.projects.length, 0);
	assert.equal(report.unmapped.sessionCount, SESSIONS.length);
	assertMoneyEqual(
		report.unmapped.totalCost,
		SESSIONS.reduce((sum, r) => sum + r.totalCost, 0),
		'ยอดต้องไม่หายแม้ map ไม่ได้เลยสักตัว',
	);
	assert.equal(report.meta.claudeProjectsDirExists, false);
});
