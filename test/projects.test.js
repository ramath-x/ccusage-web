/**
 * เทสของ project index
 *
 * ทุกเคสชี้ไป test/fixtures/projects ไม่ใช่ ~/.claude/projects จริง —
 * ข้อมูลจริงเป็น log สดที่โตตลอดเวลา เทสที่อ่านมันจะ reproduce ไม่ได้และพังเองเมื่อ user ทำงาน
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
	buildProjectIndex,
	clearProjectIndexCache,
	decodeProjectDirName,
	scanHeaderText,
} from '../dist/projects.js';

const FIXTURE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'projects');

async function loadIndex() {
	clearProjectIndexCache();
	return buildProjectIndex({ rootDir: FIXTURE_ROOT });
}

test('decodeProjectDirName เป็น lossy จริง — ยืนยันว่าทำไมห้ามใช้เป็นความจริงหลัก', () => {
	assert.equal(decodeProjectDirName('-home-user-ghost'), '/home/user/ghost');
	// ชื่อโปรเจกต์ที่มี `-` อยู่แล้วจะถูก decode ผิด — นี่คือกับดักที่ cwd ต้องมาชนะ
	assert.equal(decodeProjectDirName('-home-user-my-cool-app'), '/home/user/my/cool/app');
});

test('cwd ในไฟล์ชนะชื่อ dir ที่ decode แล้วผิด', async () => {
	const index = await loadIndex();
	const info = index.sessions.get('11111111-1111-1111-1111-111111111111');

	assert.ok(info, 'ต้อง index session นี้ได้');
	assert.equal(info.projectPath, '/home/user/my-cool-app');
	assert.notEqual(info.projectPath, '/home/user/my/cool/app');
	assert.equal(info.pathSource, 'cwd');
	assert.equal(info.pathTrusted, true);
	assert.equal(info.title, 'ปรับสูตรคำนวณค่าปรับ');
});

test('ไฟล์ที่ไม่มี cwd ยืม cwd จาก session พี่น้องใน dir เดียวกัน', async () => {
	const index = await loadIndex();
	const info = index.sessions.get('22222222-2222-2222-2222-222222222222');

	assert.ok(info);
	assert.equal(info.projectPath, '/home/user/my-cool-app');
	assert.equal(info.pathSource, 'sibling-cwd');
	assert.equal(info.pathTrusted, true);
});

test('ไม่มีใครใน dir มี cwd → ถอยไป decode ชื่อ dir และติดธงว่าไม่น่าเชื่อถือ', async () => {
	const index = await loadIndex();
	const info = index.sessions.get('44444444-4444-4444-4444-444444444444');

	assert.ok(info);
	assert.equal(info.projectPath, '/home/user/ghost');
	assert.equal(info.pathSource, 'dir-name');
	assert.equal(info.pathTrusted, false, 'path ที่เดามาต้องถูกมาร์กว่าไม่แน่นอน');
	assert.equal(info.title, undefined, 'ไม่มี ai-title ต้องเป็น undefined ไม่ใช่ string ว่าง');
	assert.ok(
		index.warnings.some((w) => w.includes('-home-user-ghost')),
		'ต้องเตือน user ว่าโปรเจกต์นี้เดา path มา',
	);
});

test('jsonl มีบรรทัดพัง → ข้ามบรรทัดนั้น ไม่ล้มทั้ง process', () => {
	const scan = scanHeaderText(
		[
			'{"type":"broken", ไม่ใช่ JSON เลย',
			'null',
			'',
			'[1,2,3]',
			'{"type":"ai-title","aiTitle":"ยังอ่านได้"}',
			'{"type":"user","cwd":"/tmp/ok"}',
		].join('\n'),
		false,
	);

	assert.equal(scan.title, 'ยังอ่านได้');
	assert.equal(scan.cwd, '/tmp/ok');
});

test('บรรทัดสุดท้ายที่โดนตัดกลางคันจากการอ่านแค่หัวไฟล์ ต้องไม่ถูก parse', () => {
	const truncated = '{"type":"user","cwd":"/tmp/ok"}\n{"type":"ai-title","aiTitle":"โดนตั';
	assert.equal(scanHeaderText(truncated, true).title, undefined);
	// ถ้าไฟล์จบพอดี (ไม่ truncate) บรรทัดนั้นก็ยังพัง parse อยู่ดี — แค่ต้องไม่ throw
	assert.doesNotThrow(() => scanHeaderText(truncated, false));
});

test('subdirectory ชื่อ UUID ไม่ถูกนับเป็น session', async () => {
	const index = await loadIndex();
	assert.equal(index.sessions.has('99999999-9999-9999-9999-999999999999'), false);
	assert.equal(index.sessions.has('abc'), false);
	assert.equal(index.sessions.size, 3, 'มีแค่ 3 ไฟล์ .jsonl ระดับบนสุดใน fixture');
});

test('dir ที่ไม่มีไฟล์ .jsonl เลย ต้องข้ามเงียบๆ ไม่พัง', async () => {
	const index = await loadIndex();
	assert.equal(index.rootExists, true);
	assert.equal(
		[...index.sessions.values()].some((s) => s.dirName === '-home-user-empty'),
		false,
	);
});

test('ไม่มีโฟลเดอร์ ~/.claude/projects → ไม่ throw แต่บอกสถานะ', async () => {
	clearProjectIndexCache();
	const index = await buildProjectIndex({ rootDir: path.join(FIXTURE_ROOT, 'ไม่มีอยู่จริง') });

	assert.equal(index.rootExists, false);
	assert.equal(index.sessions.size, 0);
	assert.equal(index.warnings.length, 1);
});
