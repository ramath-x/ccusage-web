/**
 * Report model — เอา session ดิบจาก ccusage มา join กับ project index แล้วรวมยอดต่อโปรเจกต์
 *
 * กติกาแกนของไฟล์นี้: **ทุก session ต้องมีที่ไป** ไม่โปรเจกต์ใดโปรเจกต์หนึ่งก็ถัง unmapped
 * ห้ามมี session หายระหว่างทาง เพราะนั่นแปลว่ายอดรวมบนหน้าเว็บจะน้อยกว่าความจริง
 * แบบเงียบๆ (PLAN M2 เกณฑ์ผ่าน: Σ project + Σ unmapped == Σ ดิบ)
 */

import path from 'node:path';
import { realpathSync } from 'node:fs';

import type { UsageRow } from './ccusage.js';
import type { ProjectIndex, ProjectPathSource } from './projects.js';

/**
 * agent ที่ map เข้าโปรเจกต์ได้จริง
 *
 * มีแค่ Claude Code เพราะมันเป็นตัวเดียวที่เก็บ log ต่อ session เป็นไฟล์ที่ชื่อ = session UUID
 * (PLAN §2 ข้อ 5) — gemini เก็บเป็นโฟลเดอร์ตาม basename ของโปรเจกต์ ซึ่ง**ชนกันได้**
 * ถ้ามีสองโปรเจกต์ชื่อท้ายเหมือนกัน จึงเลือกไม่เดามากกว่าโชว์ตัวเลขผิด (PLAN §2 ข้อจำกัด)
 */
const MAPPABLE_AGENTS = new Set(['claude']);

export type UnmappedReason = 'agent-not-supported' | 'no-log-file';

const UNMAPPED_REASON_TEXT: Record<UnmappedReason, string> = {
	'agent-not-supported': 'agent นี้ไม่ได้เก็บ log แยกต่อ session จึงบอกไม่ได้ว่าเป็นของโปรเจกต์ไหน',
	'no-log-file': 'หาไฟล์ log ของ session นี้ใน ~/.claude/projects ไม่เจอ (อาจถูกลบไปแล้ว)',
};

export interface TokenTotals {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	totalCost: number;
}

export interface ReportSession extends TokenTotals {
	sessionId: string;
	agent: string;
	/** ชื่อภาษาคนจาก ai-title — ไม่มีก็ให้ UI fallback เป็น UUID 8 ตัวแรกเอง */
	title?: string;
	modelsUsed: string[];
	/** gemini ไม่มี field นี้ — UI ต้องโชว์ `—` ไม่ใช่ crash (PLAN §7) */
	lastActivity?: string;
}

export interface UnmappedSession extends ReportSession {
	reason: UnmappedReason;
	reasonText: string;
}

export interface ProjectSummary extends TokenTotals {
	projectPath: string;
	pathSource: ProjectPathSource;
	/** false = path เดามาจากชื่อโฟลเดอร์ อาจผิด — UI ควรติดป้าย */
	pathTrusted: boolean;
	sessionCount: number;
	agents: string[];
	models: string[];
	lastActivity?: string;
	sessions: ReportSession[];
}

export interface UnmappedBucket extends TokenTotals {
	sessionCount: number;
	/** จำนวน session แยกตามเหตุผล — ไว้โชว์สรุปสั้นๆ โดยไม่ต้องไล่ทั้ง array */
	byReason: Record<UnmappedReason, number>;
	sessions: UnmappedSession[];
}

export interface ReportScope {
	mode: 'all' | 'project';
	/** path ที่ผู้ใช้ขอมา (ก่อน normalize) — มีเฉพาะโหมด project */
	requestedPath?: string;
	/** path หลัง normalize ที่ใช้เทียบจริง */
	resolvedPath?: string;
	/**
	 * false = cwd/path ที่ขอ ไม่ตรงกับโปรเจกต์ไหนเลย
	 * เจตนาให้เป็น "ผลว่าง" ไม่ใช่ error — M4 จะเอาไปทำ empty state พร้อมปุ่ม "ดูทั้งเครื่องแทน"
	 */
	matched: boolean;
}

export interface Report {
	generatedAt: string;
	scope: ReportScope;
	/** เรียง cost มาก→น้อย */
	projects: ProjectSummary[];
	unmapped: UnmappedBucket;
	/** ยอดของทุกอย่างที่อยู่ใน report นี้ (projects + unmapped) */
	totals: TokenTotals;
	meta: {
		/** ยอดของ **ทุก** session ที่ ccusage คืนมา ก่อนกรองด้วย scope
		 * มีไว้ให้ตรวจได้ว่า join ไม่ทำข้อมูลหาย — โหมด --all ต้องเท่ากับ totals เป๊ะ */
		rawTotals: TokenTotals;
		rawSessionCount: number;
		claudeProjectsDir: string;
		claudeProjectsDirExists: boolean;
		warnings: string[];
	};
}

function emptyTotals(): TokenTotals {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationTokens: 0,
		cacheReadTokens: 0,
		totalTokens: 0,
		totalCost: 0,
	};
}

/** บวกยอดของ session เข้า accumulator — number ที่หายไปนับเป็น 0 (gemini ไม่ครบทุก field) */
function addTotals(target: TokenTotals, row: TokenTotals): void {
	target.inputTokens += row.inputTokens;
	target.outputTokens += row.outputTokens;
	target.cacheCreationTokens += row.cacheCreationTokens;
	target.cacheReadTokens += row.cacheReadTokens;
	target.totalTokens += row.totalTokens;
	target.totalCost += row.totalCost;
}

function num(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toReportSession(row: UsageRow, title?: string): ReportSession {
	const lastActivity = row.metadata?.lastActivity;
	return {
		sessionId: row.period,
		agent: row.agent,
		...(title !== undefined ? { title } : {}),
		modelsUsed: Array.isArray(row.modelsUsed) ? row.modelsUsed : [],
		...(typeof lastActivity === 'string' ? { lastActivity } : {}),
		inputTokens: num(row.inputTokens),
		outputTokens: num(row.outputTokens),
		cacheCreationTokens: num(row.cacheCreationTokens),
		cacheReadTokens: num(row.cacheReadTokens),
		totalTokens: num(row.totalTokens),
		totalCost: num(row.totalCost),
	};
}

/**
 * normalize path ก่อนเทียบ
 *
 * ทำไมไม่เทียบ string ดิบ: `cwd` ในไฟล์ log ถูกเขียนตอนเปิด session ซึ่งอาจเป็น path
 * ที่ผ่าน symlink หรือมี trailing slash ส่วน `process.cwd()` ของเราคืน path จริงเสมอ
 * เทียบดิบแล้วจะ "ไม่ match" ทั้งที่เป็นโฟลเดอร์เดียวกัน
 *
 * realpath ล้มได้ปกติเมื่อโปรเจกต์ถูกลบไปแล้วแต่ log ยังอยู่ — กรณีนั้นถอยไปใช้
 * path.resolve ซึ่งยังจัดการ `..`/trailing slash ให้ ดีกว่าโยน error ทิ้งทั้ง report
 */
export function normalizePath(input: string): string {
	const resolved = path.resolve(input);
	try {
		return realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

export interface BuildReportOptions {
	/** ไม่ใส่ = 'all' */
	scope?: { mode: 'all' } | { mode: 'project'; targetPath: string };
	/** override เวลาใน generatedAt — ไว้ให้เทสได้ผลคงที่ */
	now?: Date;
}

/**
 * join session ดิบ ↔ project index แล้วรวมยอด
 *
 * @param sessions `report.session` จาก ccusage (ไม่ใช่ daily/weekly — period ต้องเป็น session UUID)
 */
export function buildReport(
	sessions: UsageRow[],
	index: ProjectIndex,
	options: BuildReportOptions = {},
): Report {
	const scopeInput = options.scope ?? { mode: 'all' as const };

	const rawTotals = emptyTotals();
	for (const row of sessions) addTotals(rawTotals, toReportSession(row));

	// key = path หลัง normalize เพื่อไม่ให้ path เดียวกันแตกเป็นสองโปรเจกต์เพราะ symlink
	const grouped = new Map<string, ProjectSummary>();
	const unmapped: UnmappedBucket = {
		...emptyTotals(),
		sessionCount: 0,
		byReason: { 'agent-not-supported': 0, 'no-log-file': 0 },
		sessions: [],
	};

	for (const row of sessions) {
		const info = index.sessions.get(row.period);

		// ตัดสินด้วย agent ก่อน index เสมอ: session UUID ของ agent อื่นอาจบังเอิญไปชน
		// ชื่อไฟล์ใน ~/.claude/projects ได้ การเช็ค agent ก่อนกัน false join ที่หาสาเหตุยากมาก
		if (!MAPPABLE_AGENTS.has(row.agent)) {
			pushUnmapped(unmapped, toReportSession(row), 'agent-not-supported');
			continue;
		}
		if (!info) {
			pushUnmapped(unmapped, toReportSession(row), 'no-log-file');
			continue;
		}

		const session = toReportSession(row, info.title);
		const key = normalizePath(info.projectPath);

		let summary = grouped.get(key);
		if (!summary) {
			summary = {
				...emptyTotals(),
				projectPath: key,
				pathSource: info.pathSource,
				pathTrusted: info.pathTrusted,
				sessionCount: 0,
				agents: [],
				models: [],
				sessions: [],
			};
			grouped.set(key, summary);
		}

		// โปรเจกต์เดียวอาจมี session ที่ path มาจากคนละแหล่ง — ถ้ามีตัวไหนไม่น่าเชื่อถือ
		// ต้องลดเกรดทั้งโปรเจกต์ ไม่ใช่ปล่อยผ่านเพราะบังเอิญตัวแรกน่าเชื่อถือ
		if (!info.pathTrusted) {
			summary.pathTrusted = false;
			summary.pathSource = info.pathSource;
		}

		summary.sessions.push(session);
		summary.sessionCount += 1;
		addTotals(summary, session);
		if (!summary.agents.includes(session.agent)) summary.agents.push(session.agent);
		for (const model of session.modelsUsed) {
			if (!summary.models.includes(model)) summary.models.push(model);
		}
		if (session.lastActivity && (!summary.lastActivity || session.lastActivity > summary.lastActivity)) {
			summary.lastActivity = session.lastActivity;
		}
	}

	// เรียง session ในโปรเจกต์ด้วย lastActivity ใหม่→เก่า; ตัวที่ไม่มีค่าไปท้าย (PLAN §7)
	for (const summary of grouped.values()) {
		summary.sessions.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
		summary.agents.sort();
		summary.models.sort();
	}

	let projects = [...grouped.values()].sort((a, b) => b.totalCost - a.totalCost);

	const scope: ReportScope = { mode: scopeInput.mode, matched: true };
	if (scopeInput.mode === 'project') {
		const resolved = normalizePath(scopeInput.targetPath);
		scope.requestedPath = scopeInput.targetPath;
		scope.resolvedPath = resolved;
		projects = projects.filter((project) => project.projectPath === resolved);
		// ไม่ throw: "ยืนอยู่ในโฟลเดอร์ที่ไม่เคยใช้ agent" เป็นเรื่องปกติ ไม่ใช่ความผิดพลาด
		scope.matched = projects.length > 0;
	}

	const totals = emptyTotals();
	for (const project of projects) addTotals(totals, project);

	// โหมด project ไม่เอา unmapped มารวมยอด เพราะมันไม่ใช่ของโปรเจกต์นี้แน่ๆ
	// แต่ยัง**โชว์รายการไว้** ให้ user รู้ว่ามี cost ก้อนหนึ่งที่ระบุโปรเจกต์ไม่ได้
	if (scopeInput.mode === 'all') addTotals(totals, unmapped);

	return {
		generatedAt: (options.now ?? new Date()).toISOString(),
		scope,
		projects,
		unmapped,
		totals,
		meta: {
			rawTotals,
			rawSessionCount: sessions.length,
			claudeProjectsDir: index.rootDir,
			claudeProjectsDirExists: index.rootExists,
			warnings: index.warnings,
		},
	};
}

function pushUnmapped(bucket: UnmappedBucket, session: ReportSession, reason: UnmappedReason): void {
	bucket.sessions.push({ ...session, reason, reasonText: UNMAPPED_REASON_TEXT[reason] });
	bucket.sessionCount += 1;
	bucket.byReason[reason] += 1;
	addTotals(bucket, session);
}
