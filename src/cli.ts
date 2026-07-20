#!/usr/bin/env node
/**
 * entry point ของ ccusage-web
 *
 * รอบนี้ (M1) รองรับแค่โหมด --json คือดูดข้อมูลจาก ccusage แล้วพ่นออก stdout
 * โหมด server/HTML ยังไม่ทำ — ดู PLAN.md M3
 */

import { parseArgs } from 'node:util';
import { collect, CcusageRunError, CcusageSchemaError } from './ccusage.js';

const HELP = `ccusage-web — ดู usage/cost ของ coding agent CLI เป็นหน้าเว็บ

การใช้งาน:
  ccusage-web --json [options]     พ่น JSON ที่ดูดจาก ccusage ออก stdout

Options:
  -j, --json               พ่น JSON ออก stdout (รอบนี้บังคับใส่ — โหมดเว็บยังไม่พร้อม)
      --all                ดูข้อมูลทั้งเครื่อง ทุกโปรเจกต์ ทุก agent
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

	const result = await collect({
		...(opts.since ? { since: opts.since } : {}),
		...(opts.until ? { until: opts.until } : {}),
		...(opts.timezone ? { timezone: opts.timezone } : {}),
		offline: opts.offline,
	});

	// --all ยังไม่เปลี่ยนพฤติกรรมของ collector: ccusage คืนข้อมูลทั้งเครื่องอยู่แล้ว
	// การกรองเฉพาะโปรเจกต์ต้องรอ project index (PLAN M2) — รับ flag ไว้ก่อนเพื่อไม่ให้ error
	process.stdout.write(JSON.stringify(result.report, null, 2) + '\n');

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
