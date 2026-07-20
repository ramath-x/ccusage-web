/**
 * Snapshot = "ข้อมูลดิบหนึ่งชุดที่เก็บมาแล้ว" กับ View = "มุมมองของข้อมูลชุดนั้นตาม scope ที่ขอ"
 *
 * ทำไมต้องแยกสองอย่างนี้ออกจากกัน (M4): การสลับ project ↔ all บนหน้าเว็บ **ห้ามยิง ccusage ใหม่**
 * เพราะ ccusage หนึ่งรอบใช้เวลา ~1.5 วิ (วัดไว้ที่ ccusage.ts) และข้อมูลดิบที่ต้องใช้
 * ก็เป็นชุดเดียวกันเป๊ะ — ต่างกันแค่ "จัดกลุ่ม/กรอง" ตอน buildReport ซึ่งเป็น CPU ล้วนบน
 * array ไม่กี่ร้อยแถว จึงเร็วระดับที่ผู้ใช้รู้สึกว่าทันที
 *
 * กติกา: ทุกอย่างที่ scope เปลี่ยนแล้วค่าต้องเปลี่ยน ต้องคำนวณใน buildView() เท่านั้น
 * ห้ามคำนวณตอน collect แล้วแช่ไว้ใน Snapshot — ไม่งั้นจะได้ตัวเลขของ scope เก่าปนบนหน้า
 */

import path from 'node:path';

import type { UsageRow } from './ccusage.js';
import type { ProjectIndex } from './projects.js';
import { buildReport, type Report } from './report.js';
import type { PageData } from './render/page.js';

/** ขอบเขตที่ผู้ใช้ขอดู — รูปเดียวกับที่ buildReport รับ */
export type ScopeInput = { mode: 'all' } | { mode: 'project'; targetPath: string };

/** ข้อมูลดิบหนึ่งชุด เก็บครั้งเดียวแล้วใช้ได้ทุก scope */
export interface Snapshot {
	/** แถว `session` ดิบจาก ccusage — วัตถุดิบของ buildReport */
	sessionRows: UsageRow[];
	/** แถว `daily` ดิบ — ทั้งเครื่องเสมอ (ccusage ไม่ผูก project กับยอดรายวัน) */
	daily: UsageRow[];
	/** project index ที่สแกนมาพร้อมกัน — ต้องอยู่ใน snapshot ไม่ใช่สแกนใหม่ทุก request */
	index: ProjectIndex;
	binary: string;
	usedOfflineFallback: boolean;
	offlineRequested: boolean;
	collectedAt: string;
	/** scope ที่ผู้ใช้สั่งมาทาง CLI — ใช้เมื่อ URL ไม่ได้ระบุอะไร */
	defaultScope: ScopeInput;
	/**
	 * path ปลายทางของปุ่ม "เฉพาะโปรเจกต์" บนหน้าเว็บ
	 *
	 * แยกจาก defaultScope เพราะผู้ใช้ที่สั่ง `--all` ก็ยังต้องกดสลับกลับมาดูโปรเจกต์ที่ตัวเองยืนอยู่ได้
	 * (defaultScope ของเขาคือ all ซึ่งไม่มี path ให้ใช้) — ค่านี้จึงเป็น cwd หรือ --project ที่ระบุมา
	 */
	projectTogglePath: string;
	lastRefreshError?: string;
}

/** ลิงก์สลับ scope บน header — เตรียมจากฝั่ง server เพื่อให้ปิด JS แล้วยังสลับได้ */
export interface ScopeLinks {
	allHref: string;
	projectHref: string;
	/** ชื่อสั้นของโปรเจกต์ปลายทาง (basename) — path เต็มยาวเกินกว่าจะใส่ในปุ่ม */
	projectLabel: string;
	projectPath: string;
	active: 'all' | 'project';
}

/**
 * อ่าน scope จาก query string
 *
 * รองรับสองรูปแบบเพราะใช้คนละหน้าที่:
 *   • `?scope=all` / `?scope=project` — ปุ่ม toggle บน header (ไม่ต้องรู้ path)
 *   • `?project=<path>` — drill-in จากตารางโปรเจกต์ (ต้องระบุ path ที่คลิก)
 * `project=` ชนะ `scope=` เสมอ เพราะมันเจาะจงกว่า และผู้ใช้ที่ส่ง path มาย่อมตั้งใจดู path นั้น
 *
 * ค่าที่อ่านไม่ออก/ว่าง → ถอยไปใช้ defaultScope แทนการ error: URL พิมพ์มือผิดตัวเดียว
 * ไม่ควรทำให้หน้าเว็บพัง แค่ได้มุมมองตั้งต้นก็พอ
 */
export function resolveScope(search: URLSearchParams, snapshot: Snapshot): ScopeInput {
	const project = search.get('project')?.trim();
	if (project) return { mode: 'project', targetPath: project };

	const scope = search.get('scope')?.trim().toLowerCase();
	if (scope === 'all') return { mode: 'all' };
	if (scope === 'project') return { mode: 'project', targetPath: snapshot.projectTogglePath };

	return snapshot.defaultScope;
}

function scopeLinksFor(snapshot: Snapshot, report: Report): ScopeLinks {
	// ปุ่ม "เฉพาะโปรเจกต์" ต้องชี้ไปโปรเจกต์ที่กำลังดูอยู่ ไม่ใช่ค่าตั้งต้นเสมอ —
	// ไม่งั้นผู้ใช้ที่ drill-in เข้าโปรเจกต์ B แล้วกดสลับไป all แล้วกดกลับ จะเด้งไปโปรเจกต์ A
	const current = report.scope.mode === 'project' ? report.scope.resolvedPath : undefined;
	const projectPath = current ?? snapshot.projectTogglePath;

	return {
		allHref: '/?scope=all',
		projectHref: `/?project=${encodeURIComponent(projectPath)}`,
		projectLabel: path.basename(projectPath) || projectPath,
		projectPath,
		active: report.scope.mode,
	};
}

/**
 * ประกอบมุมมองหนึ่งอันจากข้อมูลดิบ + scope ที่ขอ
 *
 * ทุก field ที่หน้าเว็บใช้ต้องออกมาจากที่นี่ที่เดียว เพื่อให้ "ตัวเลขทุกตัวบนหน้าอยู่ scope เดียวกัน"
 * เป็นเรื่องที่พิสูจน์ได้จากจุดเดียว ไม่ต้องไล่ตรวจทีละ section
 */
export function buildView(snapshot: Snapshot, scope: ScopeInput): PageData {
	const report = buildReport(snapshot.sessionRows, snapshot.index, { scope });

	return {
		report,
		daily: snapshot.daily,
		sessionRows: snapshot.sessionRows,
		binary: snapshot.binary,
		usedOfflineFallback: snapshot.usedOfflineFallback,
		offlineRequested: snapshot.offlineRequested,
		collectedAt: snapshot.collectedAt,
		scopeLinks: scopeLinksFor(snapshot, report),
		...(snapshot.lastRefreshError !== undefined ? { lastRefreshError: snapshot.lastRefreshError } : {}),
	};
}

/**
 * โครง JSON กลาง — `--json` กับ `GET /api/report` ต้องคืน**รูปเดียวกันเป๊ะ**
 *
 * ทำไมเลือกโครงนี้ (แบน report ขึ้น top level แล้วยัด meta ของการเก็บข้อมูลรวมเข้า `meta`)
 * แทนที่จะห่อเป็น `{report, daily, meta}` เหมือน /api/report เดิม:
 *
 *   1. `--json` เดิมคืน report แบนอยู่แล้ว การเลือกโครงห่อ = ทุบ consumer ของ CLI ทิ้ง
 *      ส่วนการเลือกโครงแบน = /api/report ที่ยังไม่ publish เปลี่ยนตามได้ฟรี
 *   2. `{report: {...}}` ทำให้ต้องเขียน `data.report.totals` ซึ่ง "report" ไม่ได้เพิ่มความหมายอะไร
 *      ทั้งก้อนก็คือ report อยู่แล้ว
 *   3. meta สองก้อน (meta ของ report + meta ของการเก็บข้อมูล) รวมได้โดยไม่ชนกัน —
 *      ตรวจแล้วว่าไม่มี key ซ้ำ (rawTotals/rawSessionCount/claudeProjectsDir/... กับ binary/collectedAt/...)
 *
 * `daily` อยู่ top level คู่กับ `projects` เพราะมันเป็นข้อมูลคนละแกนของ report เดียวกัน
 * ⚠️ `daily` เป็นยอด**ทั้งเครื่องเสมอ** ไม่ว่า scope จะเป็นอะไร — จึงติดธง `dailyScope` กำกับไว้
 * ให้ consumer รู้ว่าห้ามเอาไปรวมกับ `totals` ของโหมด project (PLAN §2 ข้อ 2)
 */
export function buildPayload(view: PageData): Record<string, unknown> {
	const { report } = view;

	return {
		generatedAt: report.generatedAt,
		scope: report.scope,
		projects: report.projects,
		unmapped: report.unmapped,
		totals: report.totals,
		daily: view.daily,
		meta: {
			...report.meta,
			binary: view.binary,
			collectedAt: view.collectedAt,
			usedOfflineFallback: view.usedOfflineFallback,
			offlineRequested: view.offlineRequested,
			/** ยอดรายวันเป็นของทั้งเครื่องเสมอ — ประกาศไว้ตรงๆ กันคนเอาไปเทียบกับ totals ผิด */
			dailyScope: 'machine' as const,
			...(view.lastRefreshError !== undefined ? { lastRefreshError: view.lastRefreshError } : {}),
		},
	};
}
