/**
 * HTTP server — `node:http` ล้วน ไม่มี express (PLAN §3)
 *
 * ขอบเขตของไฟล์นี้จงใจแคบ: รับ request → คืน snapshot ที่มีอยู่ → ยิง collector เมื่อถูกสั่ง Refresh
 * มันไม่รู้จัก ccusage และไม่รู้จัก ~/.claude เลย — ตัวเก็บข้อมูลถูกส่งเข้ามาเป็นฟังก์ชัน
 * เพื่อให้เทสยิง server จริงได้โดยไม่ต้องมี ccusage และไม่ต้องแตะ log จริงของผู้ใช้
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { renderPage } from './render/page.js';
import { buildPayload, buildView, resolveScope, type Snapshot } from './snapshot.js';

/**
 * bind แค่ 127.0.0.1 เท่านั้น — **ห้าม 0.0.0.0** (PLAN §4.4)
 *
 * หน้านี้ไม่มี auth และเนื้อหาคือ cost/ชื่อโปรเจกต์/ชื่องานที่ทำ ซึ่งเป็นข้อมูลภายในทั้งหมด
 * bind 0.0.0.0 = ใครก็ตามที่อยู่ Wi-Fi เดียวกัน (ร้านกาแฟ, ออฟฟิศ) เปิดดูได้ทันทีโดยเราไม่รู้ตัว
 * ค่านี้จึงเป็นค่าคงที่ ไม่เปิดให้ override ผ่าน CLI โดยตั้งใจ
 */
export const HOST = '127.0.0.1';

/**
 * เปิด server ไม่สำเร็จด้วยสาเหตุที่เรารู้จักและอธิบายเป็นภาษาคนได้แล้ว (port ชน / ไม่มีสิทธิ์)
 *
 * แยก class เพื่อให้ cli.ts พิมพ์แค่ข้อความ ไม่ต้องพ่น stack trace — port ชนเป็นเรื่องปกติ
 * ที่ผู้ใช้แก้เองได้ ไม่ใช่บั๊กของโปรแกรม การโชว์ stack ทำให้ดูเหมือนโปรแกรมพัง
 * แล้วผู้ใช้จะมองข้ามวิธีแก้ที่เขียนไว้ให้แล้ว
 */
export class ServerStartError extends Error {
	override readonly name = 'ServerStartError';
}

/** ฟังก์ชันเก็บข้อมูลใหม่หนึ่งรอบ — ส่งเข้ามาจาก cli.ts */
export type SnapshotCollector = () => Promise<Snapshot>;

export interface ServerOptions {
	/** snapshot แรกที่เก็บมาแล้วก่อนเปิด server (ผู้ใช้จะได้ไม่เจอหน้าเปล่าตอนเปิดครั้งแรก) */
	initial: Snapshot;
	collect: SnapshotCollector;
	/** 0 = ให้ OS เลือก port ว่างให้ */
	port?: number;
}

export interface RunningServer {
	port: number;
	url: string;
	server: http.Server;
	close: () => Promise<void>;
}

/**
 * ตัวถือ snapshot + กันการยิง collector ซ้อน
 *
 * ทำไมต้อง reuse promise เดิมแทนการ spawn ใหม่ (PLAN §7 แถวสุดท้าย): ปุ่ม Refresh กดรัวได้
 * และ collector ตัวหนึ่งคือการ spawn ccusage + ไล่อ่าน log หลายร้อยไฟล์ การกดสิบครั้ง
 * = ccusage สิบ process แย่ง CPU/ดิสก์กันเอง ทำให้ทุกอันช้าลงพร้อมกัน แล้วผลลัพธ์ก็เหมือนกันหมด
 * อยู่ดีเพราะอ่านข้อมูลชุดเดียวกัน — คนกดที่สองถึงสิบจึงควร "รอผลของคนแรก" ไม่ใช่เริ่มรอบใหม่
 */
export class SnapshotStore {
	private current: Snapshot;
	private inflight?: Promise<Snapshot>;

	constructor(
		initial: Snapshot,
		private readonly collector: SnapshotCollector,
	) {
		this.current = initial;
	}

	get(): Snapshot {
		return this.current;
	}

	async refresh(): Promise<Snapshot> {
		if (this.inflight) return this.inflight;

		const run = (async (): Promise<Snapshot> => {
			try {
				const next = await this.collector();
				this.current = next;
				return next;
			} finally {
				// เคลียร์ทั้งตอนสำเร็จและตอนพัง ไม่งั้น error ครั้งเดียวจะทำให้ปุ่ม Refresh
				// คืน error เดิมค้างตลอดอายุ process
				this.inflight = undefined;
			}
		})();

		this.inflight = run;
		return run;
	}

	/** เก็บ error ของ refresh ไว้กับ snapshot เดิม เพื่อให้หน้าเว็บบอกได้ว่าข้อมูลที่เห็นเป็นชุดเก่า */
	noteRefreshError(message: string): void {
		this.current = { ...this.current, lastRefreshError: message };
	}

	clearRefreshError(): void {
		if (this.current.lastRefreshError === undefined) return;
		const { lastRefreshError: _drop, ...rest } = this.current;
		this.current = rest;
	}
}

/**
 * header ความปลอดภัยชุดเล็ก
 *
 * CSP ตรงนี้ทำหน้าที่เป็น "ตัวบังคับกฎ self-contained" ด้วย: `default-src 'none'` แปลว่า
 * ถ้าวันหลังมีใครเผลอใส่ <script src="https://cdn..."> หรือ @font-face จาก Google Fonts
 * browser จะบล็อกให้เห็นทันทีตอน dev แทนที่จะหลุดขึ้น production แล้วพังตอนผู้ใช้ออฟไลน์
 * connect-src 'self' เปิดไว้เพราะปุ่ม Refresh ต้อง fetch /api/refresh ของเราเอง
 */
function securityHeaders(): Record<string, string> {
	return {
		'Content-Security-Policy':
			"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
			"img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
		'X-Content-Type-Options': 'nosniff',
		'Referrer-Policy': 'no-referrer',
		// ข้อมูล cost เปลี่ยนทุกครั้งที่ Refresh — ห้าม browser cache ไม่งั้นกด Refresh แล้วเห็นของเก่า
		'Cache-Control': 'no-store',
	};
}

function sendHtml(res: http.ServerResponse, status: number, html: string, headOnly: boolean): void {
	const body = Buffer.from(html, 'utf8');
	res.writeHead(status, {
		...securityHeaders(),
		'Content-Type': 'text/html; charset=utf-8',
		'Content-Length': body.byteLength,
	});
	res.end(headOnly ? undefined : body);
}

function sendJson(res: http.ServerResponse, status: number, value: unknown, headOnly = false): void {
	const body = Buffer.from(JSON.stringify(value, null, 2), 'utf8');
	res.writeHead(status, {
		...securityHeaders(),
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': body.byteLength,
	});
	res.end(headOnly ? undefined : body);
}

function sendText(res: http.ServerResponse, status: number, text: string, headOnly = false): void {
	const body = Buffer.from(text, 'utf8');
	res.writeHead(status, {
		...securityHeaders(),
		'Content-Type': 'text/plain; charset=utf-8',
		'Content-Length': body.byteLength,
	});
	res.end(headOnly ? undefined : body);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** แยก handler ออกมาเพื่อให้เทสเรียกได้ตรงโดยไม่ต้องเปิด socket */
export function createRequestHandler(store: SnapshotStore): http.RequestListener {
	return (req, res) => {
		const method = req.method ?? 'GET';
		const url = new URL(req.url ?? '/', `http://${HOST}`);
		const pathname = url.pathname;
		const headOnly = method === 'HEAD';
		const isRead = method === 'GET' || headOnly;

		/**
		 * ประกอบมุมมองจาก snapshot ที่มีอยู่ + scope ที่ URL ขอ
		 *
		 * ⭐ หัวใจของ M4: การสลับ scope จบตรงนี้ทั้งหมด **ไม่มีการเรียก collector**
		 * (collector = ตัวเดียวที่ spawn ccusage) จึงเป็นไปไม่ได้ที่การกด toggle จะยิง ccusage ใหม่
		 */
		const viewFor = (): ReturnType<typeof buildView> => {
			const snapshot = store.get();
			return buildView(snapshot, resolveScope(url.searchParams, snapshot));
		};

		if (pathname === '/' || pathname === '/index.html') {
			if (!isRead) {
				res.setHeader('Allow', 'GET, HEAD');
				sendText(res, 405, `method ${method} ใช้กับ ${pathname} ไม่ได้ — รองรับแค่ GET/HEAD\n`);
				return;
			}
			try {
				sendHtml(res, 200, renderPage(viewFor()), headOnly);
			} catch (err) {
				// หน้าเว็บพังไม่ควรทำให้ process ตาย — คืน 500 ที่อ่านรู้เรื่องแล้วให้ผู้ใช้กด Refresh ต่อได้
				sendText(res, 500, `เรนเดอร์หน้าเว็บไม่สำเร็จ: ${errorMessage(err)}\n`, headOnly);
			}
			return;
		}

		if (pathname === '/api/report') {
			if (!isRead) {
				res.setHeader('Allow', 'GET, HEAD');
				sendText(res, 405, `method ${method} ใช้กับ ${pathname} ไม่ได้ — รองรับแค่ GET/HEAD\n`);
				return;
			}
			// รับ ?scope= / ?project= เหมือนหน้าเว็บ เพื่อให้ JSON กับหน้าที่ผู้ใช้กำลังดูตรงกันเสมอ
			// และคืน **โครงเดียวกับ `ccusage-web --json`** เป๊ะ (ดูเหตุผลการเลือกโครงที่ buildPayload)
			sendJson(res, 200, buildPayload(viewFor()), headOnly);
			return;
		}

		if (pathname === '/api/refresh') {
			// รับทั้ง POST (ปุ่มบนหน้าเว็บ) และ GET (เรียกมือจาก curl/bookmark ได้สะดวก)
			if (method !== 'POST' && !isRead) {
				res.setHeader('Allow', 'GET, HEAD, POST');
				sendText(res, 405, `method ${method} ใช้กับ ${pathname} ไม่ได้ — รองรับ GET/POST\n`);
				return;
			}
			store
				.refresh()
				.then((snapshot) => {
					store.clearRefreshError();
					// ตั้งชื่อ key ด้วยคำว่า raw* ให้ชัดว่าเป็นยอด**ทั้งเครื่องก่อนกรอง scope**
					// ไม่ใช่ยอดของหน้าที่ผู้ใช้กำลังดู — คำตอบของ refresh ไม่ผูกกับ scope ใด scope หนึ่ง
					sendJson(
						res,
						200,
						{
							ok: true,
							collectedAt: snapshot.collectedAt,
							rawSessionCount: snapshot.sessionRows.length,
							rawTotalCost: snapshot.sessionRows.reduce(
								(sum, row) => sum + (typeof row.totalCost === 'number' ? row.totalCost : 0),
								0,
							),
						},
						headOnly,
					);
				})
				.catch((err: unknown) => {
					const message = errorMessage(err);
					store.noteRefreshError(message);
					// 503 ไม่ใช่ 500: เก็บข้อมูลรอบนี้ไม่ได้ แต่ snapshot เดิมยังเสิร์ฟได้อยู่
					sendJson(res, 503, { ok: false, error: message }, headOnly);
				});
			return;
		}

		sendText(res, 404, `ไม่มีหน้านี้: ${pathname}\n\nที่มีให้ใช้:\n  /            หน้าเว็บ\n  /api/report  ข้อมูล JSON\n  /api/refresh เก็บข้อมูลใหม่\n`, headOnly);
	};
}

/**
 * เปิด server แล้วคืน port ที่ได้จริง
 *
 * port 0 = ให้ OS เลือกให้ ซึ่งไม่มี race condition แบบการไล่ scan หา port ว่างเอง
 * (scan แล้วค่อย listen มีช่องว่างให้ process อื่นแย่ง port ไปก่อนได้เสมอ — PLAN §4.4)
 */
export function startServer(options: ServerOptions): Promise<RunningServer> {
	const store = new SnapshotStore(options.initial, options.collect);
	const server = http.createServer(createRequestHandler(store));
	const requestedPort = options.port ?? 0;

	return new Promise((resolve, reject) => {
		const onError = (err: NodeJS.ErrnoException): void => {
			server.removeListener('listening', onListening);

			if (err.code === 'EADDRINUSE') {
				// ⛔ ห้ามแอบเลื่อนไป port อื่นเงียบๆ (PLAN §4.4): ผู้ใช้ระบุ --port มาเพราะเขา
				// ตั้งใจจะเปิด URL นั้น (bookmark / reverse proxy / เปิดค้างไว้อีกแท็บ) การเลื่อนให้เอง
				// ทำให้เขาเปิดหน้าเดิมที่ค้างอยู่แล้วเห็นข้อมูลของ process เก่าโดยไม่รู้ตัว
				reject(
					new ServerStartError(
						`port ${requestedPort} ถูกใช้งานอยู่แล้ว\n` +
							`วิธีแก้:\n` +
							`  • ไม่ต้องใส่ --port เลย ระบบจะหา port ว่างให้เอง\n` +
							`  • หรือระบุ port อื่นที่ว่าง เช่น --port ${requestedPort + 1}\n` +
							`  • ดูว่าใครใช้อยู่: lsof -nP -iTCP:${requestedPort} -sTCP:LISTEN`,
					),
				);
				return;
			}
			if (err.code === 'EACCES') {
				reject(
					new ServerStartError(
						`ไม่มีสิทธิ์เปิด port ${requestedPort} (port ต่ำกว่า 1024 ต้องใช้สิทธิ์ root) — ลองเลข port ที่สูงกว่านี้`,
					),
				);
				return;
			}
			reject(err);
		};

		const onListening = (): void => {
			server.removeListener('error', onError);
			const address = server.address() as AddressInfo | null;
			if (!address || typeof address === 'string') {
				reject(new Error('เปิด server ได้แต่อ่าน port ที่ใช้จริงไม่ได้'));
				return;
			}

			resolve({
				port: address.port,
				url: `http://${HOST}:${address.port}`,
				server,
				close: () =>
					new Promise<void>((done) => {
						// ตัด keep-alive connection ที่ค้างอยู่ด้วย ไม่งั้น server.close() จะรอ
						// จนกว่า browser จะยอมปล่อย socket เอง = Ctrl+C แล้วเหมือนโปรแกรมค้าง
						server.closeAllConnections();
						server.close(() => done());
					}),
			});
		};

		server.once('error', onError);
		server.once('listening', onListening);
		server.listen({ host: HOST, port: requestedPort });
	});
}
