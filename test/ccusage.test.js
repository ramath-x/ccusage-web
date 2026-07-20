/**
 * เทสของ collector
 *
 * เทสรันบน dist/ ที่ build แล้ว (ไม่ใช่ src/) เพราะ node 20 รัน TypeScript ตรงๆ ไม่ได้
 * และเราไม่อยากลง ts-node/tsx เพิ่มตาม PLAN §3 (dependency น้อยที่สุด)
 * `npm test` มี pretest = tsc อยู่แล้ว จึงไม่มีทางเทสผ่านบน dist เก่า
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
	parseReport,
	validateReport,
	resolveCcusageBinary,
	CcusageSchemaError,
} from '../dist/ccusage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRaw = readFileSync(path.join(here, 'fixtures', 'report.json'), 'utf8');

test('parse fixture ปกติได้ครบทุก field ที่เราใช้', () => {
	const report = parseReport(fixtureRaw);

	for (const section of ['daily', 'weekly', 'monthly', 'session']) {
		assert.ok(Array.isArray(report[section]), `section ${section} ต้องเป็น array`);
		assert.ok(report[section].length > 0, `section ${section} ต้องมีอย่างน้อย 1 แถว`);
	}

	const row = report.session[0];
	for (const key of [
		'agent',
		'period',
		'inputTokens',
		'outputTokens',
		'cacheCreationTokens',
		'cacheReadTokens',
		'totalTokens',
		'totalCost',
		'modelsUsed',
		'modelBreakdowns',
	]) {
		assert.ok(key in row, `session row ต้องมี field "${key}"`);
	}

	assert.equal(typeof row.period, 'string');
	assert.equal(typeof row.totalCost, 'number');
	assert.ok(Array.isArray(row.modelsUsed));
	assert.ok(Array.isArray(row.modelBreakdowns));
	assert.equal(typeof row.modelBreakdowns[0].modelName, 'string');
	assert.equal(typeof row.modelBreakdowns[0].cost, 'number');

	assert.ok(report.totals, 'totals ควรถูกเก็บไว้เมื่อ ccusage ส่งมา');
	assert.equal(typeof report.totals.totalCost, 'number');
});

test('metadata เป็น optional — row ที่ไม่มี metadata ต้องไม่ทำให้พัง', () => {
	const report = parseReport(fixtureRaw);

	// fixture ตั้งใจเก็บทั้ง row ที่มี metadata (claude) และไม่มี (gemini)
	const withMeta = report.session.find((r) => r.metadata);
	const withoutMeta = report.session.find((r) => !r.metadata);

	assert.ok(withMeta, 'fixture ต้องมี row ที่มี metadata');
	assert.ok(withoutMeta, 'fixture ต้องมี row ที่ไม่มี metadata (เคส gemini)');
	assert.equal(typeof withMeta.metadata.lastActivity, 'string');
	assert.equal(withoutMeta.metadata, undefined);
});

test('session ไม่ใช่ array → throw error ที่บอกว่า schema เปลี่ยน', () => {
	const broken = { daily: [], weekly: [], monthly: [], session: { nope: true } };

	assert.throws(
		() => validateReport(broken),
		(err) => {
			assert.ok(err instanceof CcusageSchemaError, 'ต้องเป็น CcusageSchemaError');
			assert.match(err.message, /schema/, 'ข้อความต้องมีคำว่า schema');
			assert.match(err.message, /session/, 'ข้อความต้องบอกว่า section ไหนพัง');
			return true;
		},
	);
});

test('row ขาด period → throw error ที่บอกว่า schema เปลี่ยน', () => {
	const broken = {
		daily: [],
		weekly: [],
		monthly: [],
		session: [{ totalCost: 1.23 }],
	};

	assert.throws(
		() => validateReport(broken),
		(err) => {
			assert.ok(err instanceof CcusageSchemaError);
			assert.match(err.message, /schema/);
			assert.match(err.message, /period/);
			return true;
		},
	);
});

test('row ขาด totalCost → throw error ที่บอกว่า schema เปลี่ยน', () => {
	const broken = {
		daily: [],
		weekly: [],
		monthly: [],
		session: [{ period: 'abc' }],
	};

	assert.throws(
		() => validateReport(broken),
		(err) => {
			assert.ok(err instanceof CcusageSchemaError);
			assert.match(err.message, /schema/);
			assert.match(err.message, /totalCost/);
			return true;
		},
	);
});

test('stdout ที่ไม่ใช่ JSON → error ที่บอกว่า schema เปลี่ยน ไม่ใช่ SyntaxError ดิบ', () => {
	assert.throws(() => parseReport('<html>500</html>'), CcusageSchemaError);
	assert.throws(() => parseReport(''), CcusageSchemaError);
});

test('resolveCcusageBinary หา ccusage เจอเสมอ (อย่างน้อยตกไป npx)', () => {
	const spec = resolveCcusageBinary();

	assert.equal(typeof spec.command, 'string');
	assert.ok(spec.command.length > 0);
	assert.ok(Array.isArray(spec.baseArgs));
	assert.equal(typeof spec.label, 'string');
});
