#!/usr/bin/env node
/**
 * entry point ของ ccusage-web
 *
 * มีสองโหมด:
 *   • ไม่ใส่ --json → เก็บข้อมูลแล้วยิง web server บน port ว่าง + เปิด browser (โหมดหลัก)
 *   • --json        → พ่น report ที่ join แล้วออก stdout แล้วจบ (ไว้ต่อท่อ/debug)
 */

import { parseArgs } from 'node:util';
import { collect, CcusageRunError, CcusageSchemaError, DEFAULT_TIMEOUT_MS, type CollectOptions } from './ccusage.js';
import { buildProjectIndex } from './projects.js';
import { buildReport } from './report.js';
import { startServer, ServerStartError } from './server.js';
import { openBrowser } from './open.js';
import type { PageData } from './render/page.js';

const HELP = `ccusage-web — ดู usage/cost ของ coding agent CLI เป็นหน้าเว็บ

การใช้งาน:
  ccusage-web [options]            เก็บข้อมูลแล้วเปิดหน้าเว็บบน port ว่างอัตโนมัติ
  ccusage-web --json [options]     พ่น JSON ที่จัดกลุ่มตามโปรเจกต์แล้วออก stdout (ไม่ยิง server)

Options:
  -j, --json               พ่น JSON ออก stdout แทนการเปิดหน้าเว็บ
      --all                ดูข้อมูลทั้งเครื่อง ทุกโปรเจกต์ ทุก agent
  -p, --project <path>     ดูเฉพาะโปรเจกต์ที่ path นี้ (ไม่ใส่ = โฟลเดอร์ปัจจุบัน)
      --port <n>           ระบุ port เอง (ไม่ใส่ = ให้ OS เลือก port ว่างให้)
      --no-open            ไม่ต้องเปิด browser ให้
      --timeout <วินาที>   เพดานเวลาของการรัน ccusage หนึ่งครั้ง (ไม่ใส่ = ${DEFAULT_TIMEOUT_MS / 1000})
  -s, --since <YYYY-MM-DD> กรองตั้งแต่วันที่
  -u, --until <YYYY-MM-DD> กรองถึงวันที่ (รวมวันนั้น)
  -z, --timezone <IANA>    timezone ที่ใช้จัดกลุ่มวัน เช่น Asia/Bangkok
  -O, --offline            ใช้ตาราง pricing ที่ cache ไว้ ไม่ต้องต่อเน็ต
  -h, --help               แสดงข้อความนี้

หมายเหตุ: ตัวเลขทั้งหมดมาจาก ccusage โดยตรง — ccusage-web ไม่ได้คำนวณราคาเอง
          หน้าเว็บเปิดที่ 127.0.0.1 เท่านั้น ไม่เปิดออกนอกเครื่อง
`;

/** error ที่เกิดจาก "ผู้ใช้ใส่ค่ามาผิด" — ต่างจาก error ตอนทำงาน จึงคืน exit code 2 */
class UsageError extends Error {}

function parsePort(raw: string): number {
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new UsageError(`--port ต้องเป็นจำนวนเต็ม 0-65535 แต่ได้ "${raw}"`);
	}
	return port;
}

function parseTimeout(raw: string): number {
	const seconds = Number(raw);
	if (!Number.isFinite(seconds) || seconds <= 0) {
		throw new UsageError(`--timeout ต้องเป็นจำนวนวินาทีที่มากกว่า 0 แต่ได้ "${raw}"`);
	}
	return Math.round(seconds * 1000);
}

/**
 * เก็บข้อมูลหนึ่งรอบครบวงจร: ccusage → project index → join → ก้อนข้อมูลของหน้าเว็บ
 *
 * ทำเป็นฟังก์ชันเพื่อให้ปุ่ม Refresh บนหน้าเว็บเรียกซ้ำได้ทั้งชุด — ไม่ใช่แค่รัน ccusage ใหม่
 * เพราะ session ใหม่ที่เพิ่งเกิดจะยังไม่อยู่ใน project index เก่า (ไฟล์ log เพิ่งถูกสร้าง)
 * ถ้า refresh แค่ครึ่งเดียว session ใหม่จะไปโผล่ที่ถัง unmapped ทั้งที่ระบุโปรเจกต์ได้
 */
async function collectSnapshot(
	collectOptions: CollectOptions,
	scope: { mode: 'all' } | { mode: 'project'; targetPath: string },
	offlineRequested: boolean,
): Promise<PageData> {
	const result = await collect(collectOptions);
	const index = await buildProjectIndex();
	const report = buildReport(result.report.session, index, { scope });

	return {
		report,
		daily: result.report.daily,
		sessionRows: result.report.session,
		binary: result.binary,
		usedOfflineFallback: result.usedOfflineFallback,
		offlineRequested,
		collectedAt: new Date().toISOString(),
	};
}

async function main(): Promise<number> {
	let parsed;
	try {
		parsed = parseArgs({
			args: process.argv.slice(2),
			options: {
				json: { type: 'boolean', short: 'j', default: false },
				all: { type: 'boolean', default: false },
				project: { type: 'string', short: 'p' },
				port: { type: 'string' },
				// ตั้งชื่อ option ว่า 'no-open' ตรงๆ เพราะ parseArgs ของ node 20
				// ยังไม่รองรับการเติม --no- ให้ boolean option อัตโนมัติ
				'no-open': { type: 'boolean', default: false },
				timeout: { type: 'string' },
				since: { type: 'string', short: 's' },
				until: { type: 'string', short: 'u' },
				timezone: { type: 'string', short: 'z' },
				offline: { type: 'boolean', short: 'O', default: false },
				help: { type: 'boolean', short: 'h', default: false },
			},
			allowPositionals: false,
			strict: true,
		});
	} catch (err) {
		// parseArgs โยน error ตอนเจอ flag ที่ไม่รู้จัก — บอก user ตรงๆ แล้วชี้ไป --help
		const reason = err instanceof Error ? err.message : String(err);
		process.stderr.write(`อ่าน argument ไม่ได้: ${reason}\nดูรายการ flag ที่รองรับด้วย --help\n`);
		return 2;
	}

	const opts = parsed.values;

	if (opts.help) {
		process.stdout.write(HELP);
		return 0;
	}

	// สองอันนี้ขัดกันตรงๆ — เดาให้ว่าอันไหนชนะ = user อาจอ่านตัวเลขผิดขอบเขตโดยไม่รู้ตัว
	if (opts.all && opts.project !== undefined) {
		process.stderr.write(`ใช้ --all พร้อมกับ --project ไม่ได้ — เลือกอย่างใดอย่างหนึ่ง\n`);
		return 2;
	}

	const port = opts.port !== undefined ? parsePort(opts.port) : undefined;
	const timeoutMs = opts.timeout !== undefined ? parseTimeout(opts.timeout) : undefined;

	const collectOptions: CollectOptions = {
		...(opts.since ? { since: opts.since } : {}),
		...(opts.until ? { until: opts.until } : {}),
		...(opts.timezone ? { timezone: opts.timezone } : {}),
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
		offline: opts.offline,
	};

	// default = โฟลเดอร์ปัจจุบัน เพราะ use case หลักคือ "cd เข้ามาแล้วอยากรู้ว่าโปรเจกต์นี้กินไปเท่าไหร่"
	const scope = opts.all
		? ({ mode: 'all' } as const)
		: ({ mode: 'project', targetPath: opts.project ?? process.cwd() } as const);

	const snapshot = await collectSnapshot(collectOptions, scope, opts.offline);
	const { report } = snapshot;

	if (opts.json) {
		process.stdout.write(JSON.stringify(report, null, 2) + '\n');

		// เขียนลง stderr เพื่อไม่ให้ปนกับ JSON ตอน redirect เข้าไฟล์
		if (!report.scope.matched) {
			process.stderr.write(
				`ไม่พบข้อมูล usage ของ ${report.scope.resolvedPath} — โฟลเดอร์นี้อาจยังไม่เคยใช้ Claude Code\n` +
					`ลองดูทั้งเครื่องด้วย: ccusage-web --json --all\n`,
			);
		}
		for (const warning of report.meta.warnings) {
			process.stderr.write(`คำเตือน: ${warning}\n`);
		}
		if (snapshot.usedOfflineFallback && !opts.offline) {
			process.stderr.write('หมายเหตุ: ดึงราคาจากเน็ตไม่ได้ จึงถอยไปใช้ราคาที่ cache ไว้ (--offline)\n');
		}
		return 0;
	}

	const running = await startServer({
		initial: snapshot,
		...(port !== undefined ? { port } : {}),
		collect: () => collectSnapshot(collectOptions, scope, opts.offline),
	});

	// เตือนเรื่องราคา cache ตั้งแต่ในเทอร์มินัลด้วย ไม่ใช่แค่ banner บนหน้าเว็บ —
	// ผู้ใช้บางคนอ่านเลขจาก /api/report โดยไม่เปิดหน้าเว็บเลย
	if (snapshot.usedOfflineFallback && !opts.offline) {
		process.stdout.write('⚠ ดึงราคาจากเน็ตไม่ได้ จึงใช้ราคาที่ cache ไว้ — ตัวเลข cost อาจไม่ตรงราคาปัจจุบัน\n');
	}
	for (const warning of report.meta.warnings) {
		process.stderr.write(`คำเตือน: ${warning}\n`);
	}

	process.stdout.write(
		`\n  ccusage-web พร้อมใช้งานแล้ว\n\n` +
			`  ${running.url}\n\n` +
			`  ขอบเขต: ${report.scope.mode === 'all' ? 'ทั้งเครื่อง' : (report.scope.resolvedPath ?? '')}\n` +
			`  ปิดด้วย Ctrl+C\n\n`,
	);

	if (!opts['no-open']) {
		const opened = await openBrowser(running.url);
		if (!opened.opened) {
			process.stdout.write(`  (${opened.reason} — ก็อป URL ข้างบนไปเปิดเองได้เลย)\n\n`);
		}
	}

	await waitForShutdown(running.close);
	return 0;
}

/**
 * รอจนกว่าจะโดน Ctrl+C แล้วปิด server ให้สะอาด
 *
 * ต้องปิด server เองไม่ใช่ปล่อยให้ process ตายไปพร้อม socket ที่ค้าง เพราะ port
 * จะถูกจองต่ออีกพักหนึ่ง (TIME_WAIT) ทำให้รันซ้ำด้วย --port เดิมทันทีแล้วเจอ EADDRINUSE
 * ทั้งที่ผู้ใช้ปิดโปรแกรมไปแล้ว
 */
function waitForShutdown(close: () => Promise<void>): Promise<void> {
	return new Promise((resolve) => {
		let closing = false;
		const shutdown = (signal: NodeJS.Signals): void => {
			// กดซ้ำระหว่างกำลังปิด = ไม่ต้องทำอะไรเพิ่ม รอบแรกกำลังจัดการอยู่
			if (closing) return;
			closing = true;
			process.stdout.write(`\nได้รับ ${signal} — กำลังปิด server...\n`);
			void close().then(() => resolve());
		};

		process.once('SIGINT', shutdown);
		process.once('SIGTERM', shutdown);
	});
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((err: unknown) => {
		if (err instanceof UsageError) {
			process.stderr.write(`${err.message}\nดูรายการ flag ที่รองรับด้วย --help\n`);
			process.exitCode = 2;
			return;
		}
		if (err instanceof CcusageRunError || err instanceof CcusageSchemaError || err instanceof ServerStartError) {
			// error ที่เรารู้จัก = ข้อความไทยที่บอกวิธีแก้อยู่แล้ว ไม่ต้องโชว์ stack ให้รก
			process.stderr.write(`${err.message}\n`);
		} else {
			process.stderr.write(`เกิดข้อผิดพลาดที่ไม่คาดคิด: ${err instanceof Error ? err.stack : String(err)}\n`);
		}
		process.exitCode = 1;
	});
