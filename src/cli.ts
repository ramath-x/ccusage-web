#!/usr/bin/env node
/**
 * entry point ของ ccusage-web
 *
 * รอบนี้ (M2) รองรับแค่โหมด --json คือดูดข้อมูลจาก ccusage → join กับ project index
 * แล้วพ่น report ที่จัดกลุ่มตามโปรเจกต์ออก stdout
 * โหมด server/HTML ยังไม่ทำ — ดู PLAN.md M3
 */

import { parseArgs } from 'node:util';
import { collect, CcusageRunError, CcusageSchemaError } from './ccusage.js';
import { buildProjectIndex } from './projects.js';
import { buildReport } from './report.js';

const HELP = `ccusage-web — ดู usage/cost ของ coding agent CLI เป็นหน้าเว็บ

การใช้งาน:
  ccusage-web --json [options]     พ่น JSON ที่จัดกลุ่มตามโปรเจกต์แล้วออก stdout

Options:
  -j, --json               พ่น JSON ออก stdout (รอบนี้บังคับใส่ — โหมดเว็บยังไม่พร้อม)
      --all                ดูข้อมูลทั้งเครื่อง ทุกโปรเจกต์ ทุก agent
  -p, --project <path>     ดูเฉพาะโปรเจกต์ที่ path นี้ (ไม่ใส่ = โฟลเดอร์ปัจจุบัน)
  -s, --since <YYYY-MM-DD> กรองตั้งแต่วันที่
  -u, --until <YYYY-MM-DD> กรองถึงวันที่ (รวมวันนั้น)
  -z, --timezone <IANA>    timezone ที่ใช้จัดกลุ่มวัน เช่น Asia/Bangkok
  -O, --offline            ใช้ตาราง pricing ที่ cache ไว้ ไม่ต้องต่อเน็ต
  -h, --help               แสดงข้อความนี้

หมายเหตุ: ตัวเลขทั้งหมดมาจาก ccusage โดยตรง — ccusage-web ไม่ได้คำนวณราคาเอง
`;

async function main(): Promise<number> {
	let parsed;
	try {
		parsed = parseArgs({
			args: process.argv.slice(2),
			options: {
				json: { type: 'boolean', short: 'j', default: false },
				all: { type: 'boolean', default: false },
				project: { type: 'string', short: 'p' },
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

	// รอบนี้ยังไม่มี server — กันไม่ให้ user รันเปล่าแล้วนึกว่าโปรแกรมค้าง
	if (!opts.json) {
		process.stderr.write(
			`โหมดเว็บยังไม่พร้อมใช้งานในเวอร์ชันนี้ (อยู่ระหว่างพัฒนา — ดู PLAN.md M3)\n` +
				`ตอนนี้ใช้ได้เฉพาะ: ccusage-web --json\n`,
		);
		return 2;
	}

	// สองอันนี้ขัดกันตรงๆ — เดาให้ว่าอันไหนชนะ = user อาจอ่านตัวเลขผิดขอบเขตโดยไม่รู้ตัว
	if (opts.all && opts.project !== undefined) {
		process.stderr.write(`ใช้ --all พร้อมกับ --project ไม่ได้ — เลือกอย่างใดอย่างหนึ่ง\n`);
		return 2;
	}

	const result = await collect({
		...(opts.since ? { since: opts.since } : {}),
		...(opts.until ? { until: opts.until } : {}),
		...(opts.timezone ? { timezone: opts.timezone } : {}),
		offline: opts.offline,
	});

	// ccusage คืนข้อมูลทั้งเครื่องเสมอ — การกรองต่อโปรเจกต์เกิดที่ชั้นนี้ ไม่ใช่ที่ collector
	const index = await buildProjectIndex();

	// default = โฟลเดอร์ปัจจุบัน เพราะ use case หลักคือ "cd เข้ามาแล้วอยากรู้ว่าโปรเจกต์นี้กินไปเท่าไหร่"
	const report = buildReport(result.report.session, index, {
		scope: opts.all ? { mode: 'all' } : { mode: 'project', targetPath: opts.project ?? process.cwd() },
	});

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

	if (result.usedOfflineFallback && !opts.offline) {
		// เขียนลง stderr ไม่ใช่ stdout เพื่อไม่ให้ไปปนกับ JSON ตอน user redirect เข้าไฟล์
		process.stderr.write('หมายเหตุ: ดึงราคาจากเน็ตไม่ได้ จึงถอยไปใช้ราคาที่ cache ไว้ (--offline)\n');
	}

	return 0;
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((err: unknown) => {
		if (err instanceof CcusageRunError || err instanceof CcusageSchemaError) {
			// error ที่เรารู้จัก = ข้อความไทยที่บอกวิธีแก้อยู่แล้ว ไม่ต้องโชว์ stack ให้รก
			process.stderr.write(`${err.message}\n`);
		} else {
			process.stderr.write(`เกิดข้อผิดพลาดที่ไม่คาดคิด: ${err instanceof Error ? err.stack : String(err)}\n`);
		}
		process.exitCode = 1;
	});
