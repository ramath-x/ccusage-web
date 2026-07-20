/**
 * เทสการกู้สถานการณ์เมื่อ native binary ของ ccusage ไม่มีสิทธิ์รัน
 *
 * บั๊กจริงที่ reproduce ตรงนี้ (เจอจากเครื่อง user):
 *   sudo npm i -g @ramath/ccusage-dashboard → รันเป็น user ธรรมดา → ccusage exit 1 พร้อม
 *   "ccusage native binary is not executable: EPERM: operation not permitted, chmod '...'"
 * เพราะ @ccusage/ccusage-linux-x64 ส่งไฟล์มาแบบไม่มีบิต execute แล้ว ccusage พยายาม chmod เอง
 * แต่ไฟล์เป็นของ root ผู้ใช้ธรรมดาจึงแก้ไม่ได้
 *
 * ทุกเคสใช้ binary ปลอม (node -e) ล้วน — ไม่แตะ ~/.claude จริง ไม่ยิงเน็ต ไม่ต้องมี ccusage
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import {
	collectWith,
	findInexecutableBinaryPath,
	resolveCcusageBinaries,
	CcusageRunError,
	CcusageBinaryPermissionError,
} from '../dist/ccusage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'report.json');

/** path ที่ปรากฏใน stderr จริงจากเครื่อง user — ต้องถูกดึงออกมาแปะในคำแนะนำ chmod ให้ครบทั้งเส้น */
const BAD_PATH =
	'/usr/local/lib/node_modules/@ramath/ccusage-dashboard/node_modules/@ccusage/ccusage-linux-x64/bin/ccusage';

/** stderr ก๊อปมาจากเคสจริง (คำต่อคำ) */
const EPERM_STDERR = `ccusage native binary is not executable: EPERM: operation not permitted, chmod '${BAD_PATH}'`;

/** ไฟล์ marker ที่ binary ปลอมแตะ — ใช้พิสูจน์ว่าชั้นไหนถูกรันจริงบ้าง */
function markerPath(name) {
	return path.join(os.tmpdir(), `ccusage-web-perm-${process.pid}-${Date.now()}-${name}`);
}

/** binary ปลอมที่พังแบบ EPERM chmod — แตะ marker ทุกครั้งที่ถูกรัน เพื่อนับจำนวนรอบ */
function failingWithPermission(marker, extraStderr = '') {
	return {
		command: process.execPath,
		baseArgs: [
			'-e',
			`require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x');` +
				`process.stderr.write(${JSON.stringify(EPERM_STDERR + extraStderr)});` +
				`process.exit(1);`,
			// กั้น flag ของ ccusage (--json/--sections) ไม่ให้ node เอาไปตีความเป็น option ของตัวเอง
			'--',
		],
		label: 'ชั้นปลอมที่ไฟล์ไม่มีสิทธิ์รัน',
	};
}

/** binary ปลอมที่พังด้วยเหตุผลอื่น (ไม่เกี่ยวกับสิทธิ์ไฟล์) */
function failingWithOtherError(marker) {
	return {
		command: process.execPath,
		baseArgs: [
			'-e',
			`require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x');` +
				`process.stderr.write("error: unknown option '--sections'");` +
				`process.exit(1);`,
			'--',
		],
		label: 'ชั้นปลอมที่พังด้วย error อื่น',
	};
}

/** binary ปลอมที่ทำงานได้ปกติ — พ่น fixture JSON ออก stdout เหมือน ccusage ตัวจริง */
function succeeding(marker, label = 'ชั้นปลอมที่รันได้ (จำลอง npx)') {
	return {
		command: process.execPath,
		baseArgs: [
			'-e',
			`require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x');` +
				`process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(FIXTURE)}, 'utf8'));`,
			'--',
		],
		label,
	};
}

/** จำนวนครั้งที่ binary ปลอมตัวนั้นถูก spawn */
function runCount(marker) {
	return existsSync(marker) ? readFileSync(marker, 'utf8').length : 0;
}

function cleanupMarkers(t, ...markers) {
	t.after(async () => {
		for (const m of markers) await fs.rm(m, { force: true });
	});
}

test('ชั้นที่พังเพราะไฟล์ไม่มีสิทธิ์รัน → ต้องถอยไปชั้นถัดไป ไม่ throw ทันที', async (t) => {
	const bad = markerPath('bad');
	const good = markerPath('good');
	cleanupMarkers(t, bad, good);

	const result = await collectWith([failingWithPermission(bad), succeeding(good)], { timeoutMs: 10_000 });

	assert.equal(runCount(bad), 1, 'ชั้นแรกต้องถูกลองจริง (ไม่ใช่ข้ามไปเลย)');
	assert.equal(runCount(good), 1, 'ชั้นถัดไปต้องถูกลองต่อ ไม่ใช่ throw ตั้งแต่ชั้นแรก');

	// ผลลัพธ์ต้องเป็นรายงานปกติ เหมือนไม่เคยมีอะไรพัง
	assert.ok(Array.isArray(result.report.session));
	assert.ok(result.report.session.length > 0, 'ต้องได้ข้อมูลจริงจากชั้นที่รันผ่าน');
	assert.ok(Array.isArray(result.report.daily));
});

test('หลัง fallback แล้ว binary ที่รายงานต้องเป็นตัวที่ใช้จริง ไม่ใช่ตัวที่เลือกตอนแรก', async (t) => {
	const bad = markerPath('bad');
	const good = markerPath('good');
	cleanupMarkers(t, bad, good);

	const winner = succeeding(good, 'npx -y ccusage@latest (ตัวที่รันผ่านจริง)');
	const result = await collectWith([failingWithPermission(bad), winner], { timeoutMs: 10_000 });

	// footer บนหน้าเว็บโชว์ค่านี้ ถ้ารายงานตัวที่พังไปแล้วจะพา user ไป debug ผิดจุด
	assert.equal(result.binary, winner.label);
	assert.doesNotMatch(result.binary, /ไม่มีสิทธิ์รัน/, 'ต้องไม่ใช่ label ของชั้นที่พัง');
});

test('error อื่น (ไม่เกี่ยวสิทธิ์ไฟล์) → throw ทันที ไม่เสียเวลาลองชั้นถัดไป', async (t) => {
	const bad = markerPath('bad');
	const nextLayer = markerPath('next');
	cleanupMarkers(t, bad, nextLayer);

	await assert.rejects(
		() => collectWith([failingWithOtherError(bad), succeeding(nextLayer)], { timeoutMs: 10_000 }),
		(err) => {
			assert.ok(err instanceof CcusageRunError, 'ต้องเป็น CcusageRunError');
			assert.ok(
				!(err instanceof CcusageBinaryPermissionError),
				'ต้องไม่ถูกตีความเป็นปัญหาสิทธิ์ไฟล์',
			);
			assert.match(err.message, /exit code 1/);
			assert.match(err.message, /unknown option/, 'ต้องเห็น stderr จริงเพื่อ debug ได้');
			return true;
		},
	);

	assert.equal(runCount(bad), 1);
	assert.equal(runCount(nextLayer), 0, 'ห้ามลองชั้นถัดไป — user ต้องเห็นสาเหตุจริงทันที');
});

test('เจอ EPERM แล้วห้าม retry --offline กับ binary ตัวเดิม (สิทธิ์ไฟล์ไม่เกี่ยวกับเน็ต)', async (t) => {
	const bad = markerPath('bad');
	const good = markerPath('good');
	cleanupMarkers(t, bad, good);

	// stderr มีคำว่า pricing ปนอยู่ด้วย ซึ่งปกติจะ trigger การ retry แบบ --offline
	// แต่ปัญหาจริงคือสิทธิ์ไฟล์ → รันซ้ำตัวเดิมยังไงก็พังเหมือนเดิม ต้องไม่เผารอบ spawn ทิ้ง
	const specs = [failingWithPermission(bad, '\nfailed to fetch pricing data'), succeeding(good)];
	const result = await collectWith(specs, { timeoutMs: 10_000 });

	assert.equal(runCount(bad), 1, 'ชั้นที่พังเพราะสิทธิ์ไฟล์ต้องถูกรันแค่รอบเดียว ไม่ retry --offline');
	assert.equal(result.binary, specs[1].label);
});

test('fallback ก็พังด้วย → error ต้องบอกคำสั่ง chmod พร้อม path จริงที่ดึงมาจาก stderr', async (t) => {
	const bad = markerPath('bad');
	const alsoBad = markerPath('alsobad');
	cleanupMarkers(t, bad, alsoBad);

	// ชั้นสุดท้าย (npx) พังเพราะไม่มีเน็ต — เคสจริงของเครื่องที่ offline
	const offlineNpx = {
		command: process.execPath,
		baseArgs: [
			'-e',
			`require('node:fs').appendFileSync(${JSON.stringify(alsoBad)}, 'x');` +
				`process.stderr.write("npm error code ENOTFOUND\\nrequest to https://registry.npmjs.org failed");` +
				`process.exit(1);`,
			'--',
		],
		label: 'npx ปลอมที่ไม่มีเน็ต',
	};

	await assert.rejects(
		() => collectWith([failingWithPermission(bad), offlineNpx], { timeoutMs: 10_000 }),
		(err) => {
			assert.ok(err instanceof CcusageBinaryPermissionError, 'ต้องเป็น CcusageBinaryPermissionError');
			assert.ok(err instanceof CcusageRunError, 'ต้องเป็นลูกของ CcusageRunError ให้ cli.ts จับได้');

			// สองอย่างที่ user ต้องได้: คำสั่งที่ก๊อปไปวางได้ + path ที่ถูกต้องเป๊ะ
			assert.match(err.message, /chmod/, 'ต้องมีคำว่า chmod');
			assert.ok(
				err.message.includes(`sudo chmod +x ${BAD_PATH}`),
				'ต้องแปะคำสั่งเต็มพร้อม path จริงจาก stderr',
			);
			assert.ok(err.message.includes(BAD_PATH), 'path ต้องมาจาก stderr ไม่ใช่ที่เราเดา');

			// ทางออกถาวรที่ไม่ต้อง sudo ซ้ำอีก
			assert.match(err.message, /npm config set prefix ~\/\.npm-global/, 'ต้องแนะทางติดตั้งใต้ home');
			return true;
		},
	);

	assert.equal(runCount(bad), 1);
	// >= 1 เพราะ stderr เป็น ENOTFOUND ซึ่ง trigger การ retry แบบ --offline ตามพฤติกรรมเดิม (PLAN §7)
	// ประเด็นของเทสนี้คือ "ได้ลองชั้นถัดไปจริง" ไม่ใช่จำนวนรอบของชั้นนั้น
	assert.ok(runCount(alsoBad) >= 1, 'ต้องได้ลองชั้นถัดไปจริงก่อนยอมแพ้');
});

test('ทุกชั้นพังเพราะสิทธิ์ไฟล์ → ยังต้องได้คำแนะนำ chmod ของชั้นแรก', async (t) => {
	const first = markerPath('first');
	const second = markerPath('second');
	cleanupMarkers(t, first, second);

	await assert.rejects(
		() => collectWith([failingWithPermission(first), failingWithPermission(second)], { timeoutMs: 10_000 }),
		(err) => {
			assert.ok(err instanceof CcusageBinaryPermissionError);
			assert.ok(err.message.includes(`sudo chmod +x ${BAD_PATH}`));
			assert.match(err.message, /ลองมาแล้วทุกชั้น/, 'ต้องบอกว่าลองอะไรไปบ้าง');
			return true;
		},
	);

	assert.equal(runCount(second), 1, 'ต้องลองครบทุกชั้นก่อนยอมแพ้');
});

test('findInexecutableBinaryPath ดึง path จาก stderr จริงได้', () => {
	assert.equal(findInexecutableBinaryPath(EPERM_STDERR), BAD_PATH);

	// รูปแบบที่ต่างออกไปเล็กน้อยก็ยังต้องจับได้ (ข้อความของ ccusage/node เปลี่ยนได้)
	assert.equal(
		findInexecutableBinaryPath(`Error: EACCES: permission denied, chmod '/opt/x/bin/ccusage'`),
		'/opt/x/bin/ccusage',
	);
});

test('findInexecutableBinaryPath ต้องไม่ตีความ error อื่นว่าเป็นปัญหาสิทธิ์ไฟล์', () => {
	// ถ้า false-positive ตรงนี้ error ทั่วไปจะถูกลากไป fallback ทำให้ user รอฟรีและได้ข้อความแก้ผิดเรื่อง
	for (const stderr of [
		"error: unknown option '--sections'",
		'npm error code ENOTFOUND',
		'EACCES: permission denied, open /home/u/.claude/projects/x.jsonl',
		'TypeError: Cannot read properties of undefined',
		'',
	]) {
		assert.equal(findInexecutableBinaryPath(stderr), undefined, `ต้องไม่ match: ${stderr}`);
	}
});

test('resolveCcusageBinaries คืนชั้นเรียงลำดับ และลงท้ายด้วย npx เสมอ', () => {
	const specs = resolveCcusageBinaries();

	assert.ok(Array.isArray(specs));
	assert.ok(specs.length >= 1, 'ต้องมีอย่างน้อยชั้น npx');
	for (const spec of specs) {
		assert.equal(typeof spec.command, 'string');
		assert.ok(Array.isArray(spec.baseArgs));
		assert.equal(typeof spec.label, 'string');
	}
	// ชั้นสุดท้ายต้องเป็น npx เสมอ — เป็นตัวที่ติดตั้งลง cache ของ user จึง chmod +x ได้เอง
	assert.match(specs[specs.length - 1].label, /npx/);
});
