/**
 * สร้างภาพหน้าจอสำหรับ README จาก **ข้อมูลสมมติล้วน**
 *
 * ทำไมต้องมีสคริปต์นี้แทนที่จะถ่ายหน้าจอจริง: repo นี้เป็น public ส่วนข้อมูลที่หน้าเว็บ
 * แสดง (path ของโปรเจกต์ในเครื่อง, ชื่อ session ที่ AI ตั้งจากบทสนทนา, ยอดเงิน) เป็นข้อมูล
 * ส่วนตัวของเจ้าของเครื่องทั้งหมด — ภาพที่ commit ขึ้น repo จึงต้องมาจากข้อมูลปลอมเท่านั้น
 *
 * วิธีรัน (ต้อง build ก่อน เพราะอ่านจาก dist/):
 *   npm run build && node docs/make-screenshot.mjs
 *
 * สคริปต์นี้เดินผ่าน pipeline จริง (buildProjectIndex → buildView → renderPage)
 * ไม่ได้เขียน HTML ปลอมขึ้นมาเอง ภาพที่ได้จึงเป็นหน้าตาจริงของโปรแกรม
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { buildProjectIndex, clearProjectIndexCache } from '../dist/projects.js';
import { buildView } from '../dist/snapshot.js';
import { renderPage } from '../dist/render/page.js';

const DOCS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** โปรเจกต์สมมติ — ตั้งใจให้ชื่อมี `-` เพื่อโชว์ว่าเครื่องมืออ่าน cwd ไม่ได้เดาจากชื่อโฟลเดอร์ */
const DEMO_PROJECTS = [
	{ dirName: '-home-dev-my-app', cwd: '/home/dev/my-app' },
	{ dirName: '-home-dev-api-gateway', cwd: '/home/dev/api-gateway' },
	{ dirName: '-home-dev-docs-site', cwd: '/home/dev/docs-site' },
];

/** session สมมติ: [uuid, โปรเจกต์, ชื่อ, cost, tokens, วันที่] */
const DEMO_SESSIONS = [
	['a1111111-1111-4111-8111-111111111111', 0, 'เพิ่มหน้า dashboard สรุปยอดขาย', 12.42, 3_120_400, '2026-07-19T14:05:00.000Z'],
	['a2222222-2222-4222-8222-222222222222', 0, 'รีแฟกเตอร์ระบบ login ให้ใช้ JWT', 8.17, 2_045_900, '2026-07-18T09:31:00.000Z'],
	['a3333333-3333-4333-8333-333333333333', 0, 'ไล่บั๊กตะกร้าสินค้าคำนวณส่วนลดผิด', 5.63, 1_402_100, '2026-07-17T16:48:00.000Z'],
	['a4444444-4444-4444-8444-444444444444', 0, undefined, 1.08, 268_300, '2026-07-16T11:02:00.000Z'],
	['b1111111-1111-4111-8111-111111111111', 1, 'เขียนเทส integration ของ rate limiter', 6.94, 1_733_600, '2026-07-19T10:12:00.000Z'],
	['b2222222-2222-4222-8222-222222222222', 1, 'ย้าย config ไป environment variable', 2.31, 574_800, '2026-07-15T13:26:00.000Z'],
	['c1111111-1111-4111-8111-111111111111', 2, 'ปรับ sidebar ให้รองรับ dark mode', 3.55, 889_200, '2026-07-20T08:44:00.000Z'],
];

/** session ของ agent อื่น — โชว์ถัง unmapped ซึ่งเป็นข้อจำกัดที่ตั้งใจไม่ปิดบัง */
const DEMO_UNMAPPED = [
	['d1111111-1111-4111-8111-111111111111', 'gemini', 1.87, 465_000, '2026-07-18T19:03:00.000Z'],
];

const MODELS = ['claude-opus-4-8', 'claude-sonnet-4-6'];

/** แตก cost ก้อนเดียวเป็น token 4 ชนิดแบบคงที่ ให้ตัวเลขบนหน้าดูสมจริงและรวมกันลงตัว */
function splitTokens(total) {
	const input = Math.round(total * 0.04);
	const output = Math.round(total * 0.06);
	const cacheCreation = Math.round(total * 0.2);
	return { inputTokens: input, outputTokens: output, cacheCreationTokens: cacheCreation, cacheReadTokens: total - input - output - cacheCreation };
}

function sessionRow(sessionId, agent, cost, totalTokens, lastActivity, modelIndex) {
	const split = splitTokens(totalTokens);
	const models = modelIndex === undefined ? MODELS : [MODELS[modelIndex]];
	return {
		agent,
		period: sessionId,
		totalCost: cost,
		totalTokens,
		...split,
		modelsUsed: models,
		modelBreakdowns: models.map((modelName, i) => ({
			modelName,
			cost: i === 0 ? cost * (models.length === 1 ? 1 : 0.7) : cost * 0.3,
			inputTokens: Math.round(split.inputTokens / models.length),
			outputTokens: Math.round(split.outputTokens / models.length),
			cacheCreationTokens: Math.round(split.cacheCreationTokens / models.length),
			cacheReadTokens: Math.round(split.cacheReadTokens / models.length),
		})),
		metadata: { lastActivity },
	};
}

/** ยอดรายวันสมมติ 12 วัน — จงใจเว้นวันหนึ่งไว้เพื่อให้เห็นเส้นประ "วันที่ไม่มีข้อมูล" บนกราฟ */
function demoDaily() {
	const pattern = [4.2, 9.8, 6.1, 12.4, 3.3, 0.9, 7.7, 15.2, 11.6, 5.4, 8.9, 13.1];
	const rows = [];
	for (const [i, cost] of pattern.entries()) {
		const day = i + (i > 6 ? 10 : 8); // ข้ามช่วงวันตรงกลางเพื่อให้เห็นช่องว่าง
		const period = `2026-07-${String(day).padStart(2, '0')}`;
		const geminiShare = i % 3 === 0 ? cost * 0.15 : 0;
		const total = splitTokens(Math.round(cost * 250_000));
		rows.push({
			agent: 'all',
			period,
			totalCost: cost,
			totalTokens: Math.round(cost * 250_000),
			...total,
			modelsUsed: MODELS,
			modelBreakdowns: [],
			agents: [
				{ agent: 'claude', totalCost: cost - geminiShare },
				...(geminiShare > 0 ? [{ agent: 'gemini', totalCost: geminiShare }] : []),
			],
		});
	}
	return rows;
}

/** เขียนไฟล์ jsonl ปลอมให้เหมือนของจริงพอที่ project index จะอ่าน cwd + ai-title ได้ */
async function writeFixtures(root) {
	for (const project of DEMO_PROJECTS) {
		await fs.mkdir(path.join(root, project.dirName), { recursive: true });
	}
	for (const [sessionId, projectIndex, title] of DEMO_SESSIONS) {
		const project = DEMO_PROJECTS[projectIndex];
		const lines = [JSON.stringify({ type: 'user', cwd: project.cwd, sessionId })];
		if (title) lines.push(JSON.stringify({ type: 'ai-title', aiTitle: title }));
		await fs.writeFile(path.join(root, project.dirName, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf8');
	}
}

/** ความสูงกำหนดมือต่อภาพ เพราะ chromium --screenshot ถ่ายเท่า window ไม่ยืดตามเนื้อหา */
function shoot(htmlPath, pngPath, height) {
	const chromium = process.env['CHROMIUM_BIN'] ?? 'chromium';
	const result = spawnSync(
		chromium,
		[
			'--headless=new',
			'--no-sandbox',
			'--disable-gpu',
			'--hide-scrollbars',
			'--force-device-scale-factor=2',
			`--window-size=1280,${height}`,
			`--screenshot=${pngPath}`,
			`file://${htmlPath}`,
		],
		{ encoding: 'utf8', timeout: 120_000 },
	);
	if (result.status !== 0) {
		throw new Error(`ถ่ายภาพไม่สำเร็จ (${chromium}): ${result.stderr || result.error?.message || 'ไม่ทราบสาเหตุ'}`);
	}
}

async function main() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccusage-web-demo-'));
	try {
		await writeFixtures(root);
		clearProjectIndexCache();
		const index = await buildProjectIndex({ rootDir: root, useCache: false });

		const sessionRows = [
			...DEMO_SESSIONS.map(([id, projectIndex, , cost, tokens, at], i) =>
				sessionRow(id, 'claude', cost, tokens, at, i % 3 === 0 ? undefined : i % 2),
			),
			...DEMO_UNMAPPED.map(([id, agent, cost, tokens, at]) => sessionRow(id, agent, cost, tokens, at, 0)),
		];

		const snapshot = {
			sessionRows,
			daily: demoDaily(),
			index,
			binary: 'bundled dependency (node_modules/.bin/ccusage)',
			usedOfflineFallback: false,
			offlineRequested: false,
			collectedAt: '2026-07-20T09:15:00.000Z',
			defaultScope: { mode: 'all' },
			projectTogglePath: '/home/dev/my-app',
		};

		const shots = [
			['all', { mode: 'all' }, 'screenshot-all.png', 1880],
			['project', { mode: 'project', targetPath: '/home/dev/my-app' }, 'screenshot-project.png', 1490],
		];

		for (const [name, scope, pngName, height] of shots) {
			const html = renderPage(buildView(snapshot, scope));
			const htmlPath = path.join(root, `${name}.html`);
			await fs.writeFile(htmlPath, html, 'utf8');
			const pngPath = path.join(DOCS_DIR, pngName);
			shoot(htmlPath, pngPath, height);
			process.stdout.write(`เขียน ${pngPath}\n`);
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

await main();
