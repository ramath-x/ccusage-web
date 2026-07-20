/**
 * ตัวเก็บข้อมูลจาก `ccusage` — spawn CLI ตัวจริงแล้วกิน JSON ที่มันพ่นออกมา
 *
 * ทำไมต้อง spawn CLI แทนการ import ccusage เป็น library:
 * ccusage เปิด API ระดับ CLI เป็นสัญญาที่นิ่งกว่า internal module ของมัน
 * และการ spawn ทำให้ผู้ใช้ที่มี ccusage เวอร์ชันของตัวเอง (พร้อม config/pricing cache)
 * ได้ตัวเลขชุดเดียวกับที่เห็นในเทอร์มินัล ไม่ใช่ตัวเลขจากเวอร์ชันที่เรา pin ไว้
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';

/** ยอดแยกตามโมเดลใน 1 แถว */
export interface ModelBreakdown {
	modelName: string;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	cost: number;
}

/**
 * 1 แถวของรายงาน — ทุก section (daily/weekly/monthly/session) ใช้รูปร่างเดียวกัน
 * ต่างกันแค่ความหมายของ `period`: วันที่ / สัปดาห์ / เดือน / **session UUID**
 */
export interface UsageRow {
	agent: string;
	period: string;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	totalCost: number;
	modelsUsed: string[];
	modelBreakdowns: ModelBreakdown[];
	/**
	 * optional จริงๆ — session ของ gemini ไม่มี key นี้เลย (ยืนยันจากข้อมูลจริง)
	 * ห้าม assume ว่ามี ไม่งั้นตอนเรียงตาม lastActivity จะพัง (PLAN §7)
	 */
	metadata?: {
		lastActivity?: string;
		agents?: string[];
	};
	/** มีเฉพาะ daily/weekly/monthly ตอนส่ง `--by-agent` — session ไม่มี */
	agents?: UsageRow[];
}

export interface UsageTotals {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	totalCost: number;
}

export interface CcusageReport {
	daily: UsageRow[];
	weekly: UsageRow[];
	monthly: UsageRow[];
	session: UsageRow[];
	totals?: UsageTotals;
}

export interface CollectOptions {
	since?: string;
	until?: string;
	timezone?: string;
	offline?: boolean;
	/** เวลาสูงสุดที่ยอมให้ ccusage รัน (มิลลิวินาที) — ไม่ใส่ = DEFAULT_TIMEOUT_MS */
	timeoutMs?: number;
}

/**
 * เพดานเวลาของการรัน ccusage หนึ่งครั้ง
 *
 * ที่มาของตัวเลข — วัดบนเครื่องนี้ (2026-07-20, log จริง 155 session / 32 วัน):
 *   • ccusage ตัวเดียวโดดๆ (bundled dependency)        ~1.0-1.2 วิ
 *   • collect() ครบวงจร (spawn + สแกน ~/.claude)       ~1.3-1.5 วิ
 *   • fallback ชั้น 3 `npx -y ccusage@latest` (cache เปล่า) ~2.2 วิ
 * เลือก 60 วิ = ~27 เท่าของเคสที่ช้าที่สุดที่วัดได้ เผื่อเครื่องช้า/เน็ตอืด/log ใหญ่กว่านี้มาก
 * โดยยังไม่ทำให้ปุ่ม Refresh บนหน้าเว็บค้างจนผู้ใช้คิดว่าโปรแกรมตาย
 *
 * ทำไมต้องมีเพดานตั้งแต่แรก: ไม่มี timeout = ถ้า ccusage ค้าง (โดยเฉพาะชั้น npx ที่รอเน็ต)
 * เราค้างตามแบบไม่มีทางออก — บน CLI ยังกด Ctrl+C ได้ แต่บนหน้าเว็บผู้ใช้เห็นแค่ปุ่มหมุนค้าง
 */
export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * เวลาที่ให้ child เก็บของหลังส่ง SIGTERM ก่อนจะ SIGKILL ทิ้ง
 * สั้นได้เพราะ ccusage ไม่มี state ที่ต้อง flush — เผื่อไว้แค่ให้มันปิด stream ตัวเอง
 */
const KILL_GRACE_MS = 2_000;

/** section ที่เราขอมาในการ spawn ครั้งเดียว */
const SECTIONS = ['daily', 'weekly', 'monthly', 'session'] as const;
type Section = (typeof SECTIONS)[number];

/**
 * ccusage schema เพี้ยนไปจากที่เราคาด
 * แยก error class ออกมาเพราะวิธีแก้ต่างกันสิ้นเชิงกับ error ตอน spawn:
 * อันนี้แปลว่า "อัปเดต ccusage-dashboard" ไม่ใช่ "ติดตั้ง ccusage"
 */
export class CcusageSchemaError extends Error {
	override readonly name = 'CcusageSchemaError';
	constructor(detail: string) {
		super(
			`ccusage schema เปลี่ยนไปจากที่รองรับ: ${detail}\n` +
				`วิธีแก้: อัปเดต ccusage-dashboard เป็นเวอร์ชันล่าสุด (npm i -g @ramath/ccusage-dashboard@latest)\n` +
				`ถ้ายังไม่หาย แจ้ง issue ที่ https://github.com/ramath-x/ccusage-web/issues พร้อมเวอร์ชัน ccusage ที่ใช้`,
		);
	}
}

/** รัน ccusage ไม่สำเร็จ (หา binary ไม่เจอ / exit != 0) */
export class CcusageRunError extends Error {
	override readonly name: string = 'CcusageRunError';
	constructor(
		message: string,
		readonly stderr = '',
	) {
		super(message);
	}
}

/**
 * แปลงมิลลิวินาทีเป็นวินาทีที่อ่านรู้เรื่อง
 * ค่าต่ำกว่า 1 วินาที (เจอตอนเทสหรือตอน user ตั้ง --timeout เล็กๆ) ต้องไม่ถูกปัดจนเพี้ยน
 * เช่น 50ms ต้องได้ "0.05" ไม่ใช่ "0.1" — ไม่งั้น error โกหกว่าเราให้เวลามากกว่าที่ให้จริง
 */
function formatSeconds(ms: number): string {
	const seconds = ms / 1000;
	return seconds >= 1 ? String(Math.round(seconds * 10) / 10) : String(Number(seconds.toPrecision(2)));
}

/**
 * ccusage รันนานเกินเพดานจนถูก kill
 *
 * สืบทอดจาก CcusageRunError เพื่อให้ตัวเรียกที่ catch error "ที่เรารู้จัก" อยู่แล้ว
 * (cli.ts / server.ts) พิมพ์ข้อความไทยให้เลยโดยไม่ต้องไล่เพิ่ม catch ทีละจุด
 * แต่แยก class ไว้เพราะวิธีแก้ของผู้ใช้ต่างกัน: อันนี้คือ "รอนานขึ้น" หรือ "ตัดเน็ตออกด้วย --offline"
 * ไม่ใช่ "ติดตั้ง ccusage" หรือ "อัปเดต ccusage-dashboard"
 */
export class CcusageTimeoutError extends CcusageRunError {
	override readonly name: string = 'CcusageTimeoutError';
	constructor(
		readonly timeoutMs: number,
		label: string,
		stderr = '',
	) {
		super(
			`ccusage ใช้เวลาเกิน ${formatSeconds(timeoutMs)} วินาที จึงถูกยกเลิก\n` +
				`ใช้ binary: ${label}\n` +
				`วิธีแก้:\n` +
				`  • ถ้าค้างตอนดึงตารางราคาจากเน็ต ลองใส่ --offline เพื่อใช้ราคาที่ cache ไว้\n` +
				`  • ถ้าข้อมูล log เยอะจริงและต้องใช้เวลานาน เพิ่มเพดานด้วย --timeout <วินาที>` +
				(stderr.trim() ? `\n--- stderr ที่ได้ก่อนถูกยกเลิก ---\n${stderr.trim()}` : ''),
			stderr,
		);
	}
}

/** วิธีเรียก ccusage 1 แบบ — แยก command/args เพราะบางชั้นต้องรันผ่าน node หรือ npx */
interface BinarySpec {
	command: string;
	baseArgs: string[];
	/** ไว้บอก user ว่าสุดท้ายเราใช้ตัวไหน เวลา debug */
	label: string;
}

/** หาไฟล์ที่รันได้ชื่อ `name` ใน PATH — ไม่ใช้ `which` เพราะไม่อยากพึ่ง external command */
function findOnPath(name: string): string | undefined {
	const rawPath = process.env['PATH'];
	if (!rawPath) return undefined;

	// Windows ต้องลองนามสกุลจาก PATHEXT ด้วย ส่วน POSIX ใช้ชื่อเปล่า
	const exts =
		process.platform === 'win32'
			? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
			: [''];

	for (const dir of rawPath.split(path.delimiter)) {
		if (!dir) continue;
		for (const ext of exts) {
			const candidate = path.join(dir, name + ext);
			try {
				accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {
				// ไม่มีหรือรันไม่ได้ — ลองตัวถัดไป
			}
		}
	}
	return undefined;
}

/** หา entry script ของ ccusage ที่ติดมาเป็น dependency ของเราเอง */
function findBundledCcusage(): string | undefined {
	try {
		const require = createRequire(import.meta.url);
		const pkgPath = require.resolve('ccusage/package.json');
		const pkg = require('ccusage/package.json') as { bin?: string | Record<string, string> };
		const binField = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['ccusage'];
		if (!binField) return undefined;
		return path.resolve(path.dirname(pkgPath), binField);
	} catch {
		// dependency ถูก prune ทิ้ง (เช่น --omit=optional) — ตกไปใช้ชั้นถัดไป
		return undefined;
	}
}

/**
 * หา ccusage 3 ชั้นตามลำดับ — เรียงจาก "ตรงใจ user + เร็ว" ไป "ช้าและต้องมีเน็ต"
 *
 * 1. PATH — ถ้า user ติดตั้ง ccusage เองไว้ ต้องเคารพเวอร์ชัน/config ของเขา
 *    ตัวเลขบนเว็บจะได้ตรงกับที่เขาเห็นตอนพิมพ์ `ccusage` เอง
 * 2. dependency ที่ pin มากับเรา — schema ตรงกับที่ test ไว้แน่นอน และไม่ต้องแตะเน็ต
 *    รันผ่าน `node <entry>` ตรงๆ ไม่พึ่ง shim ใน .bin เพราะ package manager บางตัว
 *    (pnpm/yarn PnP หรือกรณีเราเป็น transitive dep) ไม่ได้สร้าง shim ไว้ให้
 * 3. `npx -y ccusage@latest` — ทางสุดท้าย ช้าและต้องมีเน็ต แต่ทำให้ `npx @ramath/ccusage-dashboard`
 *    ยังทำงานได้แม้ dependency หายไป
 */
export function resolveCcusageBinary(): BinarySpec {
	const onPath = findOnPath('ccusage');
	if (onPath) {
		return { command: onPath, baseArgs: [], label: `PATH (${onPath})` };
	}

	const bundled = findBundledCcusage();
	if (bundled) {
		// process.execPath = node ตัวที่กำลังรันอยู่ ไม่ใช่ `node` ใน PATH ซึ่งอาจคนละเวอร์ชัน
		return {
			command: process.execPath,
			baseArgs: [bundled],
			label: `bundled dependency (${bundled})`,
		};
	}

	return {
		command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
		baseArgs: ['-y', 'ccusage@latest'],
		label: 'npx -y ccusage@latest (fallback ช้า ต้องมีเน็ต)',
	};
}

/** ประกอบ flag ที่ส่งต่อไปให้ ccusage */
function buildArgs(options: CollectOptions): string[] {
	const args = ['--json', '--sections', SECTIONS.join(','), '--by-agent'];
	if (options.since) args.push('--since', options.since);
	if (options.until) args.push('--until', options.until);
	if (options.timezone) args.push('--timezone', options.timezone);
	if (options.offline) args.push('--offline');
	return args;
}

interface SpawnResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/**
 * รัน ccusage หนึ่งครั้งพร้อมเพดานเวลา
 *
 * export ไว้ให้เทสเรียกตรงด้วย binary ปลอมที่จงใจค้าง — พิสูจน์ว่า timeout ทำงานจริง
 * โดยไม่ต้องพึ่ง ccusage ตัวจริงหรือแตะ ~/.claude
 */
export function runOnce(
	spec: BinarySpec,
	args: string[],
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<SpawnResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(spec.command, [...spec.baseArgs, ...args], {
			// ไม่ใช้ shell:true — args มาจาก user (--since/--timezone) จะกลายเป็น shell injection
			shell: false,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		let stdout = '';
		let stderr = '';
		let settled = false;
		let killTimer: NodeJS.Timeout | undefined;

		/**
		 * timer ต้องถูกเคลียร์ทุกทางออก ไม่งั้น process ของเราจะไม่ยอมจบ
		 * (timer ที่ยัง active นับเป็นงานค้างใน event loop) — โหมด --json จะแขวนหลังพิมพ์ JSON เสร็จ
		 */
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;

			// SIGTERM ก่อนเพื่อให้โอกาสปิด stream ตัวเอง แล้วค่อย SIGKILL ถ้าไม่ยอมตาย
			// ต้องฆ่าให้ตายจริง ไม่งั้น child ที่ค้างจะยึด CPU/เน็ตต่อไปหลังเราคืน error ไปแล้ว
			child.kill('SIGTERM');
			killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
			killTimer.unref();

			reject(new CcusageTimeoutError(timeoutMs, spec.label, stderr));
		}, timeoutMs);

		const cleanup = (): void => {
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
		};

		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk: string) => {
			stderr += chunk;
		});

		child.on('error', (err: NodeJS.ErrnoException) => {
			if (settled) return;
			settled = true;
			cleanup();

			if (err.code === 'ENOENT') {
				reject(
					new CcusageRunError(
						`หา ccusage ไม่เจอ (ลองแล้ว: ${spec.label})\n` +
							`วิธีแก้: ติดตั้งด้วย \`npm i -g ccusage\` หรือรัน ccusage-dashboard ผ่าน npx เพื่อให้ดึง ccusage มาให้อัตโนมัติ`,
					),
				);
				return;
			}
			reject(new CcusageRunError(`รัน ccusage ไม่สำเร็จ: ${err.message}`));
		});

		child.on('close', (code) => {
			// ถึงตรงนี้หลัง timeout ได้ (คือ child ตายเพราะโดนเรา kill) — reject ไปแล้ว ห้าม resolve ทับ
			if (settled) {
				cleanup();
				return;
			}
			settled = true;
			cleanup();
			resolve({ code, stdout, stderr });
		});
	});
}

/**
 * เดาว่า error รอบแรกเกิดจากดึงราคาจากเน็ตไม่ได้หรือเปล่า
 *
 * ทำไมต้องเดาแทนที่จะ retry ทุก error: ถ้า retry มั่วเวลา user พิมพ์ flag ผิด
 * เขาจะต้องรอ ccusage รันสองรอบก่อนเห็น error จริง — ช้าและสับสน
 * เดาผิดฝั่ง false-negative ไม่อันตราย เพราะ user ยังได้เห็น stderr ดิบอยู่ดี
 */
function looksLikeNetworkFailure(stderr: string): boolean {
	const haystack = stderr.toLowerCase();
	return [
		'enotfound',
		'econnrefused',
		'econnreset',
		'etimedout',
		'eai_again',
		'getaddrinfo',
		'fetch failed',
		'network',
		'socket hang up',
		'pricing',
		'litellm',
	].some((needle) => haystack.includes(needle));
}

/** ตัด stderr ให้สั้นพอจะอ่านได้ แต่ยังเห็นบรรทัดสุดท้ายที่มักเป็นสาเหตุจริง */
function tailLines(text: string, maxLines = 20): string {
	const lines = text.trimEnd().split('\n');
	return lines.length <= maxLines ? lines.join('\n') : lines.slice(-maxLines).join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * ตรวจ key ที่เราใช้จริงหลัง parse (PLAN §7/§9)
 *
 * ทำไมต้องตรวจทั้งที่ TypeScript มี type อยู่แล้ว: type หายไปตอน runtime
 * ถ้า ccusage เปลี่ยน schema แล้วเราปล่อยผ่าน `period`/`totalCost` จะเป็น undefined
 * แล้วไหลไปโผล่เป็น "NaN" / "$undefined" บนหน้าเว็บ — ตัวเลขผิดแบบเงียบๆ
 * แย่กว่าพังตรงนี้เยอะ เพราะ user เชื่อตัวเลขไปแล้ว
 * ตรวจแค่ key ที่ใช้จริง ไม่ตรวจทั้งก้อน เพื่อให้ ccusage เพิ่ม field ใหม่ได้โดยไม่พังเรา
 */
export function validateReport(parsed: unknown): CcusageReport {
	if (!isRecord(parsed)) {
		throw new CcusageSchemaError(`คาดว่าจะได้ JSON object แต่ได้ ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
	}

	const report: Partial<Record<Section, UsageRow[]>> = {};

	for (const section of SECTIONS) {
		const rows = parsed[section];
		if (!Array.isArray(rows)) {
			throw new CcusageSchemaError(
				`section "${section}" ควรเป็น array แต่ได้ ${rows === undefined ? 'ไม่มี key นี้เลย' : typeof rows}`,
			);
		}

		rows.forEach((row, index) => {
			if (!isRecord(row)) {
				throw new CcusageSchemaError(`${section}[${index}] ควรเป็น object แต่ได้ ${typeof row}`);
			}
			if (typeof row['period'] !== 'string') {
				throw new CcusageSchemaError(
					`${section}[${index}] ขาด field "period" (ต้องเป็น string แต่ได้ ${typeof row['period']})`,
				);
			}
			if (typeof row['totalCost'] !== 'number') {
				throw new CcusageSchemaError(
					`${section}[${index}] ขาด field "totalCost" (ต้องเป็น number แต่ได้ ${typeof row['totalCost']})`,
				);
			}
		});

		report[section] = rows as UsageRow[];
	}

	const result: CcusageReport = {
		daily: report.daily!,
		weekly: report.weekly!,
		monthly: report.monthly!,
		session: report.session!,
	};

	// totals เป็นของแถม ไม่ใช่ key ที่เราพึ่ง — ขาดได้ ไม่ต้อง throw
	if (isRecord(parsed['totals'])) {
		result.totals = parsed['totals'] as unknown as UsageTotals;
	}

	return result;
}

/** parse stdout เป็น JSON — แยกจาก validate เพื่อให้ error บอกได้ว่าพังตอน parse หรือตอนตรวจ schema */
export function parseReport(stdout: string): CcusageReport {
	const trimmed = stdout.trim();
	if (!trimmed) {
		throw new CcusageSchemaError('ccusage ไม่ได้พ่นอะไรออกมาทาง stdout เลย (คาดว่าจะได้ JSON)');
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new CcusageSchemaError(
			`อ่าน JSON จาก ccusage ไม่ได้ (${reason})\n` + `ขึ้นต้นด้วย: ${trimmed.slice(0, 200)}`,
		);
	}

	return validateReport(parsed);
}

export interface CollectResult {
	report: CcusageReport;
	/** ใช้ binary ตัวไหน — ไว้โชว์ใน footer/debug */
	binary: string;
	/** ต้องถอยไปใช้ --offline หรือเปล่า — หน้าเว็บควรบอก user ว่าราคาอาจเป็นของเก่า */
	usedOfflineFallback: boolean;
}

/**
 * รัน ccusage แล้วคืน report ที่ validate แล้ว
 *
 * retry ด้วย `--offline` รอบสองเมื่อรอบแรกล้มเพราะเน็ต (PLAN §7):
 * ccusage ดึงตาราง pricing จากอินเทอร์เน็ต ถ้าเน็ตล่ม/อยู่หลัง proxy มันจะ exit != 0
 * ทั้งที่ log usage ในเครื่องอ่านได้ปกติ — การถอยไปใช้ราคาที่ cache ไว้
 * ให้ตัวเลขที่ใกล้เคียงพอใช้งาน ดีกว่าโชว์ error แล้วไม่ให้ดูอะไรเลย
 */
export async function collect(options: CollectOptions = {}): Promise<CollectResult> {
	const spec = resolveCcusageBinary();
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const first = await runOnce(spec, buildArgs(options), timeoutMs);
	if (first.code === 0) {
		return {
			report: parseReport(first.stdout),
			binary: spec.label,
			usedOfflineFallback: Boolean(options.offline),
		};
	}

	const canRetryOffline = !options.offline && looksLikeNetworkFailure(first.stderr);
	if (canRetryOffline) {
		// เพดานเวลาเป็น "ต่อการรันหนึ่งครั้ง" ไม่ใช่ยอดรวม — เคสนี้จึงรอได้ถึง 2×timeout
		// ยอมรับได้เพราะรอบสองจะเกิดต่อเมื่อรอบแรก **จบแล้ว** ด้วย exit != 0 เท่านั้น
		// (ถ้ารอบแรก timeout จะ throw ออกไปเลย ไม่ retry — ผู้ใช้ที่รอค้างต้องได้คำตอบตามเวลาที่ตั้งไว้)
		const second = await runOnce(spec, buildArgs({ ...options, offline: true }), timeoutMs);
		if (second.code === 0) {
			return {
				report: parseReport(second.stdout),
				binary: spec.label,
				usedOfflineFallback: true,
			};
		}
		// รอบ offline ก็ยังพัง — รายงาน stderr ของรอบ offline เพราะเป็นความพยายามล่าสุด
		throw new CcusageRunError(
			`ccusage ล้มเหลว (exit ${second.code}) ทั้งรอบปกติและรอบ --offline\n` +
				`ใช้ binary: ${spec.label}\n` +
				`--- stderr จาก ccusage ---\n${tailLines(second.stderr) || '(ว่าง)'}`,
			second.stderr,
		);
	}

	throw new CcusageRunError(
		`ccusage จบด้วย exit code ${first.code}\n` +
			`ใช้ binary: ${spec.label}\n` +
			`--- stderr จาก ccusage ---\n${tailLines(first.stderr) || '(ว่าง)'}`,
		first.stderr,
	);
}
