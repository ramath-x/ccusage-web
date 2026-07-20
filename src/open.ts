/**
 * เปิด browser ให้ผู้ใช้ — best-effort เท่านั้น
 *
 * กติกาแกน: **ห้าม throw และห้ามทำให้ process ตายไม่ว่ากรณีใด**
 * การเปิด browser เป็นของแถม ส่วนงานจริงคือ server ที่รันอยู่แล้ว ถ้าเปิดไม่ได้
 * (เครื่องไม่มี GUI, รันผ่าน ssh, WSL ที่ไม่มี wslu) ผู้ใช้แค่ก็อป URL ไปเปิดเองได้
 * การพังทั้งโปรแกรมเพราะเปิดหน้าต่างไม่ได้คือการแลกที่ไม่คุ้มเลย
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface OpenResult {
	opened: boolean;
	/** คำสั่งที่ใช้เปิดได้สำเร็จ */
	via?: string;
	/** เหตุผลที่เปิดไม่ได้ — เอาไปบอกผู้ใช้พร้อม URL */
	reason?: string;
}

interface Candidate {
	command: string;
	args: (url: string) => string[];
}

/** ตรวจว่ารันอยู่บน WSL หรือเปล่า — ตัวชี้ขาดว่าจะลอง wslview/explorer.exe ไหม */
export function isWsl(): boolean {
	if (process.platform !== 'linux') return false;
	if (process.env['WSL_DISTRO_NAME'] || process.env['WSL_INTEROP']) return true;
	try {
		// WSL เขียนคำว่า microsoft ไว้ใน kernel version เสมอ (ทั้ง WSL1 และ WSL2)
		return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
	} catch {
		return false;
	}
}

/**
 * ลำดับคำสั่งที่จะลอง
 *
 * บน WSL ต้องเอา wslview/explorer.exe ขึ้นก่อน xdg-open เพราะ xdg-open ใน WSL
 * มักมีอยู่จริงแต่ชี้ไป browser ฝั่ง Linux ที่ไม่ได้ติดตั้ง → เปิดไม่ขึ้นแบบเงียบๆ
 * ส่วน wslview/explorer.exe ส่งต่อไปให้ browser ฝั่ง Windows ซึ่งเป็นตัวที่ผู้ใช้มองเห็นจริง
 */
export function browserCandidates(): Candidate[] {
	if (process.platform === 'darwin') {
		return [{ command: 'open', args: (url) => [url] }];
	}
	if (process.platform === 'win32') {
		// start เป็น builtin ของ cmd ไม่ใช่ไฟล์ .exe จึงต้องเรียกผ่าน cmd
		// "" ตัวแรกคือ title ที่ start ต้องการเมื่อ argument มี quote
		return [{ command: 'cmd.exe', args: (url) => ['/c', 'start', '', url] }];
	}

	const linux: Candidate[] = [];
	if (isWsl()) {
		linux.push({ command: 'wslview', args: (url) => [url] });
		linux.push({ command: 'explorer.exe', args: (url) => [url] });
	}
	linux.push({ command: 'xdg-open', args: (url) => [url] });
	return linux;
}

/**
 * ลองรันคำสั่งหนึ่งตัว
 *
 * เช็คแค่ว่า "spawn ติดไหม" (event `spawn`) ไม่รอ exit code เพราะ explorer.exe
 * คืน exit code 1 ทั้งที่เปิดหน้าต่างสำเร็จ — ถ้าไปดู exit code จะเข้าใจผิดว่าล้มเหลว
 * แล้วไล่ลองตัวถัดไปจนหน้าเว็บเด้งขึ้นมาซ้ำหลายอัน
 */
function trySpawn(candidate: Candidate, url: string): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (ok: boolean): void => {
			if (settled) return;
			settled = true;
			resolve(ok);
		};

		try {
			const child = spawn(candidate.command, candidate.args(url), {
				// detached + unref: ไม่ให้ browser ที่เปิดค้างไว้ ผูก lifetime กับ process ของเรา
				detached: true,
				stdio: 'ignore',
				shell: false,
			});
			child.once('error', () => finish(false));
			child.once('spawn', () => {
				child.unref();
				finish(true);
			});
		} catch {
			finish(false);
		}
	});
}

export async function openBrowser(url: string): Promise<OpenResult> {
	const candidates = browserCandidates();
	const tried: string[] = [];

	for (const candidate of candidates) {
		tried.push(candidate.command);
		if (await trySpawn(candidate, url)) {
			return { opened: true, via: candidate.command };
		}
	}

	return {
		opened: false,
		reason:
			tried.length > 0
				? `เปิด browser อัตโนมัติไม่ได้ (ลองแล้ว: ${tried.join(', ')})`
				: 'ไม่รู้จักวิธีเปิด browser บนแพลตฟอร์มนี้',
	};
}
