/**
 * เทส timeout ของ collector
 *
 * ใช้ binary ปลอมที่จงใจค้าง (node -e "setInterval(...)") แทน ccusage ตัวจริง —
 * ทำให้พิสูจน์ได้ว่า timeout ทำงานจริง โดยไม่ต้องพึ่งเน็ต ไม่ต้องมี ccusage
 * และไม่ต้องรอนานเท่าค่า default 60 วินาที
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runOnce, CcusageTimeoutError, CcusageRunError, DEFAULT_TIMEOUT_MS } from '../dist/ccusage.js';

/** binary ปลอมที่ไม่มีวันจบเอง — จำลอง ccusage ที่ค้างรอเน็ต */
const HANGING = {
	command: process.execPath,
	// เขียน stderr ออกมาก่อนค้าง เพื่อพิสูจน์ว่า output ที่ได้ก่อนโดน kill ยังติดไปกับ error
	baseArgs: ['-e', 'process.stderr.write("กำลังดึงราคา..."); setInterval(() => {}, 1000);'],
	label: 'binary ปลอมสำหรับเทส',
};

test('ค่า default timeout อยู่ในระดับที่สมเหตุสมผล', () => {
	assert.equal(DEFAULT_TIMEOUT_MS, 60_000);
});

test('child ที่ค้าง → error ภายในเวลาที่ตั้ง ไม่ค้างยาว', async () => {
	const timeoutMs = 300;
	const started = Date.now();

	await assert.rejects(
		() => runOnce(HANGING, [], timeoutMs),
		(err) => {
			assert.ok(err instanceof CcusageTimeoutError, 'ต้องเป็น CcusageTimeoutError');
			// สืบทอดจาก CcusageRunError เพื่อให้ cli.ts ที่ catch อยู่แล้วพิมพ์ข้อความไทยให้เลย
			assert.ok(err instanceof CcusageRunError, 'ต้องเป็นลูกของ CcusageRunError ด้วย');
			assert.equal(err.timeoutMs, timeoutMs);
			return true;
		},
	);

	const elapsed = Date.now() - started;
	// เผื่อ overhead ของการ spawn node — แต่ต้องไม่ใกล้เคียงกับ "ค้างยาว"
	assert.ok(elapsed < timeoutMs + 2000, `ต้อง error ไวๆ แต่ใช้เวลา ${elapsed}ms`);
});

test('ข้อความ error บอกจำนวนวินาที + แนะนำ --offline และ --timeout', async () => {
	await assert.rejects(
		() => runOnce(HANGING, [], 500),
		(err) => {
			assert.match(err.message, /เกิน 0\.5 วินาที/, 'ต้องบอกเพดานเวลาเป็นวินาทีที่อ่านรู้เรื่อง');
			assert.match(err.message, /--offline/, 'ต้องแนะนำ --offline');
			assert.match(err.message, /--timeout/, 'ต้องบอกวิธีเพิ่มเพดานเวลา');
			assert.match(err.message, /กำลังดึงราคา/, 'stderr ที่ได้ก่อนถูกยกเลิกต้องติดมาด้วย');
			return true;
		},
	);
});

test('timeout แล้วต้อง kill child จริง ไม่ปล่อยค้างเป็นผี', async (t) => {
	// child เขียน pid ของตัวเองลงไฟล์ก่อนค้าง — เทสจะได้ตามไปเช็คว่ามันตายจริงหรือเปล่า
	// (ถ้าไม่ kill มันจะยังยึด CPU/เน็ตอยู่ต่อไปหลังเราคืน error ให้ผู้ใช้แล้ว)
	const pidFile = path.join(os.tmpdir(), `ccusage-web-test-${process.pid}-${Date.now()}.pid`);
	t.after(async () => {
		await fs.rm(pidFile, { force: true });
	});

	const hangingWithPid = {
		command: process.execPath,
		baseArgs: [
			'-e',
			`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
		],
		label: 'binary ปลอมที่บอก pid ตัวเอง',
	};

	await assert.rejects(() => runOnce(hangingWithPid, [], 300), CcusageTimeoutError);

	const pid = Number(await fs.readFile(pidFile, 'utf8'));
	assert.ok(Number.isInteger(pid) && pid > 0, 'child ต้องได้รันจริงและเขียน pid ไว้');

	// รอให้ SIGTERM ทำงาน แล้วยืนยันว่า process หายไปจริง (signal 0 = แค่ถามว่ายังมีชีวิตไหม)
	let alive = true;
	for (let i = 0; i < 40 && alive; i += 1) {
		await delay(50);
		try {
			process.kill(pid, 0);
		} catch {
			alive = false;
		}
	}
	assert.equal(alive, false, `child pid ${pid} ต้องถูก kill ไปแล้ว ไม่ค้างเป็น process ผี`);
});

test('งานที่จบทันเวลา ต้องผ่านปกติ ไม่โดน timeout เล่นงาน', async () => {
	const quick = {
		command: process.execPath,
		baseArgs: ['-e', 'process.stdout.write("เสร็จแล้ว")'],
		label: 'binary ปลอมที่จบไว',
	};

	const result = await runOnce(quick, [], 5000);
	assert.equal(result.code, 0);
	assert.equal(result.stdout, 'เสร็จแล้ว');
});

test('timer ต้องถูกเคลียร์หลังงานจบ — ไม่งั้น process จะไม่ยอมจบเอง', async () => {
	const quick = {
		command: process.execPath,
		baseArgs: ['-e', 'process.stdout.write("ok")'],
		label: 'binary ปลอมที่จบไว',
	};

	// ตั้ง timeout ยาวมาก: ถ้า clearTimeout ไม่ถูกเรียก timer ตัวนี้จะค้างใน event loop
	// แล้วเทสไฟล์นี้จะไม่จบภายในเวลาปกติ (node --test จะรอจน handle ว่าง)
	await runOnce(quick, [], 10 * 60 * 1000);

	const handles = process.getActiveResourcesInfo().filter((name) => name === 'Timeout');
	assert.equal(handles.length, 0, 'ต้องไม่มี Timeout ค้างหลัง runOnce จบ');
});
