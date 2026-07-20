/**
 * Project index — ตัวเชื่อม "session UUID" ↔ "โปรเจกต์ไหน"
 *
 * ทำไมต้องมีไฟล์นี้: `ccusage session --json` คืน `period` เป็น session UUID เปล่าๆ
 * ไม่มี project path ติดมาเลย (PLAN §2 ข้อ 2) — ถ้าไม่สร้าง index เอง
 * ฟีเจอร์ "ดูเฉพาะโปรเจกต์นี้" เป็นไปไม่ได้
 *
 * join key = ชื่อไฟล์ `~/.claude/projects/<dir>/<uuid>.jsonl` ตัดนามสกุล
 * ซึ่งตรงกับ `period` ที่ ccusage คืนมา (ยืนยันจากข้อมูลจริงแล้ว — PLAN §2 ข้อ 5)
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** ที่มาของ project path — สำคัญกว่าที่คิด เพราะความน่าเชื่อถือต่างกันคนละชั้น */
export type ProjectPathSource =
	/** อ่าน `cwd` จากในไฟล์ session เอง — แม่นที่สุด */
	| 'cwd'
	/** ไฟล์นี้ไม่มี `cwd` แต่ session อื่นใน dir เดียวกันมี — ดูเหตุผลที่ resolveDirectoryCwd */
	| 'sibling-cwd'
	/** ไม่มีใครใน dir มี `cwd` เลย ต้อง decode จากชื่อ dir ซึ่ง **lossy** */
	| 'dir-name';

export interface ProjectSessionInfo {
	/** = ชื่อไฟล์ตัด .jsonl = join key กับ `period` ของ ccusage */
	sessionId: string;
	/** path ของโปรเจกต์ที่ session นี้สังกัด (ยังไม่ normalize — normalize ตอนเทียบใน report.ts) */
	projectPath: string;
	pathSource: ProjectPathSource;
	/** false = path นี้เดามาจากชื่อ dir อาจผิด — UI ควรติดป้ายเตือน */
	pathTrusted: boolean;
	/** ชื่อ session ภาษาคนจาก `{"type":"ai-title"}` — ไม่มีก็ได้ (session สั้นๆ ยังไม่ทันตั้งชื่อ) */
	title?: string;
	/** ชื่อ directory ดิบใน ~/.claude/projects — ไว้ debug ตอน path เพี้ยน */
	dirName: string;
	logFile: string;
}

export interface ProjectIndex {
	/** sessionId → ข้อมูลโปรเจกต์ */
	sessions: Map<string, ProjectSessionInfo>;
	/** root ที่สแกนจริง */
	rootDir: string;
	/** false = เครื่องนี้ไม่มี ~/.claude/projects — ทุก session จะตกไป unmapped (PLAN §7) */
	rootExists: boolean;
	/** เรื่องที่ผู้ใช้ควรรู้ เช่น dir ที่ decode path ไม่ได้ / ไฟล์อ่านไม่ออก */
	warnings: string[];
}

export interface BuildProjectIndexOptions {
	/** override ไว้ให้เทสชี้ไป fixture — เทสห้ามแตะ ~/.claude จริง */
	rootDir?: string;
	/** ปิด cache (เทสที่แก้ไฟล์ระหว่างรัน) */
	useCache?: boolean;
}

/**
 * อ่านหัวไฟล์แค่ 64KB
 *
 * ทำไมไม่อ่านทั้งไฟล์: log จริงในเครื่องนี้ใหญ่ถึง 8 MB ต่อ session และมี 200+ ไฟล์
 * การอ่านทั้งหมดคือหลาย GB ต่อการเปิดหน้าเว็บหนึ่งครั้ง ทั้งที่ข้อมูลที่เราต้องการ
 * (`ai-title` + `cwd`) เป็น metadata ที่ Claude Code เขียนไว้ช่วงต้น session
 * วัดจริงแล้ว 232/236 ไฟล์เจอ `cwd` ภายใน 64KB — ที่เหลือมี fallback รองรับข้างล่าง
 */
const HEAD_BYTES = 64 * 1024;

/** ผลที่แกะได้จากหัวไฟล์ 1 ไฟล์ (ก่อนเติม path จาก sibling) */
interface HeaderScan {
	title?: string;
	cwd?: string;
}

interface CacheEntry extends HeaderScan {
	mtimeMs: number;
	size: number;
}

/**
 * cache ระดับ module — key = absolute path ของไฟล์ log
 *
 * invalidate ด้วย mtime + size: ไฟล์ log ถูก append ตลอดเวลาที่ user คุยกับ agent
 * แต่ `ai-title`/`cwd` อยู่หัวไฟล์และไม่เปลี่ยน การ re-scan ทุกรอบจึงเป็นการอ่าน
 * 64KB × 236 ไฟล์ทิ้งเปล่าๆ ทุกครั้งที่กด Refresh
 */
const headerCache = new Map<string, CacheEntry>();

/** ล้าง cache — ไว้ให้เทสเรียกระหว่างเคส ไม่ได้ตั้งใจให้ production ใช้ */
export function clearProjectIndexCache(): void {
	headerCache.clear();
}

export function defaultClaudeProjectsDir(): string {
	return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * decode ชื่อ dir กลับเป็น path — **lossy ยอมรับความผิดพลาด**
 *
 * Claude Code แทนทั้ง `/` และ `.` ด้วย `-` เวลาตั้งชื่อ dir ทำให้ decode ย้อนกลับ
 * ไม่มีทางถูกเสมอ ตัวอย่างจริงจากเครื่องนี้:
 *   `-home-synap-unixdev-newcarfly-docker-laravel-12`        → เดาได้ `/home/synap/unixdev/newcarfly/docker/laravel/12`
 *   แต่ cwd จริงคือ                                            `/home/synap/unixdev/newcarfly-docker-laravel-12`
 *   `-home-synap-unixdev-newcarfly-docker-laravel-12--ai-plans` → cwd จริงคือ `.../newcarfly-docker-laravel-12/.ai/plans`
 * ฟังก์ชันนี้จึงเป็น **ทางเลือกสุดท้าย** เท่านั้น และผลลัพธ์ต้องติดธง pathTrusted=false เสมอ
 */
export function decodeProjectDirName(dirName: string): string {
	return dirName.replace(/-/g, '/');
}

/** ตัดบรรทัดสุดท้ายที่อาจโดนตัดกลางคันจากการอ่านแค่ 64KB ทิ้ง — parse ไม่ได้อยู่ดี */
function splitCompleteLines(chunk: string, truncated: boolean): string[] {
	const lines = chunk.split('\n');
	if (truncated) lines.pop();
	return lines;
}

/**
 * หา `cwd` ตัวแรกใน object แบบ recursive
 *
 * ทำไมต้อง recursive: `cwd` ไม่ได้อยู่ระดับบนสุดเสมอ บาง entry ห่อไว้ใต้ payload ย่อย
 * จำกัดความลึกกันไฟล์แปลกๆ ทำ stack ระเบิด
 */
function findCwd(value: unknown, depth = 0): string | undefined {
	if (depth > 6 || value === null || typeof value !== 'object') return undefined;

	if (!Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		const own = record['cwd'];
		// path ต้องขึ้นต้นด้วย / หรือ drive letter — กัน field ชื่อ cwd ที่เก็บค่าอย่างอื่น
		if (typeof own === 'string' && own.length > 0) return own;
	}

	for (const child of Array.isArray(value) ? value : Object.values(value as object)) {
		const found = findCwd(child, depth + 1);
		if (found) return found;
	}
	return undefined;
}

/** แกะ title + cwd จากหัวไฟล์ — บรรทัดพังข้ามทิ้ง ห้ามพังทั้ง process (PLAN §7) */
export function scanHeaderText(chunk: string, truncated: boolean): HeaderScan {
	const result: HeaderScan = {};

	for (const line of splitCompleteLines(chunk, truncated)) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let entry: unknown;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			// jsonl พังกลางไฟล์เกิดได้จริงตอน agent ถูก kill ระหว่างเขียน — ข้ามบรรทัดนี้พอ
			continue;
		}
		if (entry === null || typeof entry !== 'object') continue;

		const record = entry as Record<string, unknown>;

		if (result.title === undefined && record['type'] === 'ai-title' && typeof record['aiTitle'] === 'string') {
			const title = (record['aiTitle'] as string).trim();
			if (title) result.title = title;
		}

		if (result.cwd === undefined) {
			const cwd = findCwd(record);
			if (cwd) result.cwd = cwd;
		}

		// ได้ครบทั้งคู่แล้วไม่ต้องอ่านต่อ
		if (result.title !== undefined && result.cwd !== undefined) break;
	}

	return result;
}

async function readHeader(filePath: string, useCache: boolean): Promise<HeaderScan> {
	const stat = await fs.stat(filePath);

	if (useCache) {
		const cached = headerCache.get(filePath);
		if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
			return { ...(cached.title !== undefined ? { title: cached.title } : {}), ...(cached.cwd !== undefined ? { cwd: cached.cwd } : {}) };
		}
	}

	const handle = await fs.open(filePath, 'r');
	let bytesRead = 0;
	const buffer = Buffer.allocUnsafe(Math.min(HEAD_BYTES, Math.max(stat.size, 1)));
	try {
		({ bytesRead } = await handle.read(buffer, 0, buffer.length, 0));
	} finally {
		await handle.close();
	}

	const truncated = bytesRead < stat.size;
	const scan = scanHeaderText(buffer.subarray(0, bytesRead).toString('utf8'), truncated);

	if (useCache) {
		headerCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, ...scan });
	}
	return scan;
}

/**
 * เลือก cwd ประจำ directory จาก session ที่อ่านเจอ
 *
 * ทำไมยืม cwd ของ session พี่น้องได้: ชื่อ dir ถูกสร้างจาก cwd ตอนเปิด session
 * ทุก session ที่ลงมาอยู่ dir เดียวกันจึงมาจาก cwd เดียวกันโดยนิยาม
 * (ยืนยันจริง: สุ่ม 40 ไฟล์ใน dir ที่ใหญ่ที่สุด ได้ cwd ตรงกันทั้ง 40)
 *
 * จำเป็นเพราะมี session ที่ `cwd` โผล่ลึกเกิน 64KB จริง (เจอ 3/236 ไฟล์ ลึกสุด 633KB)
 * ทางเลือกอื่นคือไล่อ่านไฟล์ 8MB นั้นทั้งไฟล์ ซึ่งแพงกว่ามากเพื่อข้อมูลที่รู้อยู่แล้ว
 * ใช้ค่าที่พบบ่อยที่สุดกันกรณีมีไฟล์แปลกปลอมหลุดมาแถวเดียว
 */
function resolveDirectoryCwd(scans: HeaderScan[]): string | undefined {
	const counts = new Map<string, number>();
	for (const scan of scans) {
		if (!scan.cwd) continue;
		counts.set(scan.cwd, (counts.get(scan.cwd) ?? 0) + 1);
	}

	let best: string | undefined;
	let bestCount = 0;
	for (const [cwd, count] of counts) {
		if (count > bestCount) {
			best = cwd;
			bestCount = count;
		}
	}
	return best;
}

export async function buildProjectIndex(options: BuildProjectIndexOptions = {}): Promise<ProjectIndex> {
	const rootDir = options.rootDir ?? defaultClaudeProjectsDir();
	const useCache = options.useCache ?? true;

	const index: ProjectIndex = {
		sessions: new Map(),
		rootDir,
		rootExists: true,
		warnings: [],
	};

	let dirEntries;
	try {
		dirEntries = await fs.readdir(rootDir, { withFileTypes: true });
	} catch {
		// ไม่มี ~/.claude/projects = ยังไม่เคยใช้ Claude Code หรือเก็บ log ไว้ที่อื่น
		// ไม่ใช่ error ของเรา — เดินต่อโดยให้ทุก session ตกไป unmapped (PLAN §7)
		index.rootExists = false;
		index.warnings.push(`ไม่พบโฟลเดอร์ ${rootDir} — ระบุโปรเจกต์ให้ session ของ Claude Code ไม่ได้`);
		return index;
	}

	for (const dirEntry of dirEntries) {
		if (!dirEntry.isDirectory()) continue;

		const dirName = dirEntry.name;
		const dirPath = path.join(rootDir, dirName);

		let fileEntries;
		try {
			fileEntries = await fs.readdir(dirPath, { withFileTypes: true });
		} catch {
			index.warnings.push(`อ่านโฟลเดอร์ ${dirPath} ไม่ได้ — ข้ามไป`);
			continue;
		}

		// ใน dir มี subdirectory ชื่อเป็น UUID ปนอยู่ด้วย (ที่เก็บ tool-results ของ subagent)
		// ต้องกรองเอาเฉพาะไฟล์ .jsonl ระดับบนสุด ไม่งั้นจะได้ sessionId ปลอม
		const logFiles = fileEntries
			.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
			.map((entry) => entry.name);

		if (logFiles.length === 0) continue;

		const scanned: Array<{ sessionId: string; logFile: string; scan: HeaderScan }> = [];
		for (const fileName of logFiles) {
			const logFile = path.join(dirPath, fileName);
			try {
				const scan = await readHeader(logFile, useCache);
				scanned.push({ sessionId: fileName.slice(0, -'.jsonl'.length), logFile, scan });
			} catch {
				// ไฟล์ถูกลบระหว่างสแกน / สิทธิ์ไม่พอ — ข้ามไฟล์เดียว ไม่ล้มทั้ง index
				index.warnings.push(`อ่านไฟล์ ${logFile} ไม่ได้ — ข้ามไป`);
			}
		}

		const dirCwd = resolveDirectoryCwd(scanned.map((item) => item.scan));
		const decodedFallback = decodeProjectDirName(dirName);
		if (dirCwd === undefined) {
			index.warnings.push(
				`ไม่พบ cwd ในไฟล์ log ของ ${dirName} — ใช้ path ที่เดาจากชื่อโฟลเดอร์ (${decodedFallback}) ซึ่งอาจไม่ถูกต้อง`,
			);
		}

		for (const item of scanned) {
			const ownCwd = item.scan.cwd;
			const projectPath = ownCwd ?? dirCwd ?? decodedFallback;
			const pathSource: ProjectPathSource = ownCwd ? 'cwd' : dirCwd ? 'sibling-cwd' : 'dir-name';

			index.sessions.set(item.sessionId, {
				sessionId: item.sessionId,
				projectPath,
				pathSource,
				pathTrusted: pathSource !== 'dir-name',
				...(item.scan.title !== undefined ? { title: item.scan.title } : {}),
				dirName,
				logFile: item.logFile,
			});
		}
	}

	return index;
}
