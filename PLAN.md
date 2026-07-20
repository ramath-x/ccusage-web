# ccusage-web — แผนงาน

> เครื่องมือ CLI แบบ `npx` ที่รัน `ccusage` แล้ว **render เป็นหน้า HTML เสิร์ฟบน port ว่างอัตโนมัติ**
> ดูได้ทั้ง **ทีละโปรเจกต์** และ **ทั้งเครื่อง** (รวมทุก agent ที่ ccusage ตรวจเจอ)

- **Repo:** `ramath-x/ccusage-web` (public)
- **Runtime:** Node.js >= 20 (เครื่องนี้ v20.19.0), TypeScript
- **แรงบันดาลใจโครงสร้าง:** [Plong-Wasin/planner-mcp](https://github.com/Plong-Wasin/planner-mcp) (TS + build → รันด้วย node/npx, ไม่มี framework หนัก)

---

## 1. โจทย์

ทุกวันนี้ดู usage ได้แค่ `npx ccusage` ในเทอร์มินัล — เป็นตาราง ASCII อ่านย้อนหลัง/เทียบโปรเจกต์ยาก
อยากได้:

1. รันคำสั่งเดียว → เปิดเว็บดูสวยๆ ได้เลย ไม่ต้อง deploy ไม่ต้องตั้ง server ถาวร
2. เลือกดู **เฉพาะโปรเจกต์ที่ยืนอยู่** (`cd` เข้ามาแล้วสั่ง) หรือ **ทั้งเครื่อง**
3. Port ต้อง **หาที่ว่างเอง** ไม่ชนกับ dev server อื่นที่รันค้างอยู่

---

## 2. Ground truth ที่ตรวจสอบมาแล้ว (2026-07-20)

ข้อมูลชุดนี้ **verify จากเครื่องจริงแล้ว** ไม่ใช่การเดา — เป็นฐานของ design ทั้งหมด

| # | สิ่งที่ตรวจ | ผลจริง | ผลต่อ design |
|---|---|---|---|
| 1 | `ccusage --help` | มี subcommand `daily / weekly / monthly / session / blocks` และ flag `-j, --json`, `-s/--since`, `-u/--until`, `-z/--timezone`, `--sections`, `--by-agent`, `-O/--offline` | เรียก CLI แล้วกิน JSON ได้เลย ไม่ต้อง parse ตาราง ASCII |
| 2 | `ccusage session --json` | field `period` = **session UUID** (เช่น `00c50d5f-41aa-...`) **ไม่มี project path เลย** | ⛔ **ccusage บอก per-project ไม่ได้** → ต้องสร้าง project index เอง (ข้อ 4.2) |
| 3 | JSON row มีอะไร | `agent`, `inputTokens`, `outputTokens`, `cacheCreationTokens`, `cacheReadTokens`, `totalTokens`, `totalCost`, `modelsUsed[]`, `modelBreakdowns[]`, `metadata.lastActivity` | มีครบพอทำ dashboard ไม่ต้องคำนวณราคาเอง |
| 4 | `~/.claude/projects/` | 10 dirs ชื่อเป็น path ที่ถูก encode (`/` → `-`) เช่น `-home-synap-unixdev-newcarfly-docker-laravel-12` | ใช้เป็น project key ได้ |
| 5 | **ชื่อไฟล์ jsonl == session UUID** | `~/.claude/projects/*/00c50d5f-41aa-4322-8769-e3255ee081e0.jsonl` **มีอยู่จริง ตรงกับ `period` ในข้อ 2** | ✅ **นี่คือ join key** ที่ทำให้ per-project เป็นไปได้ |
| 6 | เนื้อใน jsonl | บรรทัดแรกๆ มี `{"type":"ai-title","aiTitle":"รีวิวโค้ด commits สามตัว"}` และ entry ของ message มี `cwd` | ได้ **ชื่อ session ภาษาคน** โชว์แทน UUID + ได้ path จริงกันกรณี decode ชื่อ dir ผิด |
| 7 | agent อื่นในเครื่อง | มีแค่ `~/.gemini/` (นอกนั้น codex/opencode/copilot/amp ฯลฯ ไม่มี) | ต้องรองรับกรณี "ไม่มี log dir" อย่างสุภาพ |
| 8 | `~/.gemini/tmp/` | เป็นชื่อโฟลเดอร์ **basename ของโปรเจกต์** (`newcarfly-docker-laravel-12`, `opdc-award-12`) ไม่ใช่ UUID | Gemini map project ได้แค่ **best-effort ด้วย basename** ไม่ 100% |
| 9 | `gh auth status` | login เป็น `ramath-x`, scope `repo` ครบ | สร้าง/พุช repo ได้เลย |

### ⚠️ ข้อจำกัดที่ต้องยอมรับตั้งแต่ต้น

- **per-project ทำได้แม่นเฉพาะ Claude Code** (เพราะมี join key ข้อ 5)
- agent อื่น (gemini/codex/...) → เข้าถัง **"ทั้งเครื่อง"** ได้ปกติ แต่ตอนกรอง `--project` จะโชว์แยกเป็นกลุ่ม `unmapped` พร้อมป้ายบอกเหตุผล
  **ห้ามเดามั่วแล้วโชว์เป็นตัวเลขของโปรเจกต์นั้น** — ตัวเลขผิดแย่กว่าไม่มีตัวเลข

---

## 3. สถาปัตยกรรม

```
  npx ccusage-web  [--project . | --all]
          │
          ▼
  ┌───────────────────┐   spawn: ccusage --json --sections daily,weekly,monthly,session
  │  collector        │──────────────────────────────────────────────┐
  │  (src/ccusage.ts) │                                              │
  └───────────────────┘                                              ▼
          │                                              { session:[...], daily:[...] }
          ▼
  ┌───────────────────┐   scan ~/.claude/projects/*/<uuid>.jsonl
  │  project index    │   → Map<sessionId, {projectPath, title, lastActivity}>
  │  (src/projects.ts)│
  └───────────────────┘
          │
          ▼  join by session UUID
  ┌───────────────────┐
  │  report model     │   รวมยอดต่อ project / ต่อ agent / ต่อ model / ต่อวัน
  │  (src/report.ts)  │
  └───────────────────┘
          │
          ├──► GET /              → HTML (server-side render, self-contained)
          ├──► GET /api/report    → JSON ดิบ (ไว้ต่อยอด/debug)
          └──► GET /api/refresh   → รัน collector ใหม่ (ปุ่ม Refresh)
                     ▲
              node:http บน port ว่าง (listen(0))
```

**หลักการ:** dependency น้อยที่สุด — ใช้ `node:http` + `node:child_process` + `node:fs` ล้วน
ไม่มี express / ไม่มี React / **ไม่มี CDN** (ต้องใช้งานได้ตอนออฟไลน์) — CSS + JS inline ในหน้าเดียว

---

## 4. รายละเอียดการทำงาน

### 4.1 เก็บข้อมูลจาก ccusage

```bash
ccusage --json --sections daily,weekly,monthly,session --by-agent
```

- spawn ครั้งเดียวได้ทุก section (`--sections` โหลดรอบเดียว) — เร็วกว่ายิงทีละ subcommand
- หา binary ตามลำดับ: `ccusage` ใน PATH → `node_modules/.bin/ccusage` (dependency ของเราเอง) → `npx -y ccusage@latest` (ช้าสุด ใช้เป็น fallback)
- ส่งต่อ flag `--since / --until / --timezone / --offline` จาก CLI ของเราตรงๆ
- ถ้า exit code ไม่ใช่ 0 → โชว์ stderr ของ ccusage ตรงๆ **ห้ามกลืน error เงียบ**

### 4.2 สร้าง project index (หัวใจของฟีเจอร์ per-project)

```
สแกน ~/.claude/projects/*/
  ├── ชื่อ dir  → decode  "-home-synap-unixdev-foo" → "/home/synap/unixdev/foo"
  ├── ชื่อไฟล์ *.jsonl (ตัด .jsonl) = sessionId   ← join key
  └── อ่าน head ของไฟล์ ~64KB หา:
        • {"type":"ai-title", aiTitle}  → ชื่อ session ภาษาคน
        • field cwd ตัวแรก             → project path ที่เชื่อถือได้กว่าชื่อ dir
```

**ทำไมต้องอ่าน `cwd` ทั้งที่ decode ชื่อ dir ได้:** การ encode แทน `/` ด้วย `-` เป็น **lossy** — โปรเจกต์ที่ชื่อมี `-` อยู่แล้ว (เช่น `newcarfly-docker-laravel-12`) decode กลับตรงๆ จะได้ path ผิด
→ **ใช้ `cwd` เป็นความจริง, ชื่อ dir เป็น fallback ตอนอ่าน cwd ไม่เจอ**

Perf: อ่านแค่หัวไฟล์ (ไฟล์จริงใหญ่ถึง 2.4 MB), cache ผลไว้ใน memory + เช็ค `mtime` ก่อนอ่านซ้ำ

### 4.3 CLI spec

```bash
npx ccusage-web                    # โปรเจกต์ปัจจุบัน (cwd) — โหมด default
npx ccusage-web --all              # ทั้งเครื่อง ทุกโปรเจกต์ ทุก agent
npx ccusage-web --project ~/x/y    # เจาะจง path
npx ccusage-web --port 4321        # ระบุ port เอง (ชนแล้ว error ชัดๆ ไม่แอบเปลี่ยน)
npx ccusage-web --no-open          # ไม่เปิด browser
npx ccusage-web --since 2026-07-01 --until 2026-07-20
npx ccusage-web --json > out.json  # ไม่ยิง server, พ่น JSON ที่ join แล้วออก stdout
```

**default = โปรเจกต์ปัจจุบัน** เพราะ use case หลักคือ "cd เข้ามาแล้วอยากรู้ว่าโปรเจกต์นี้กินไปเท่าไหร่"
ถ้า cwd ไม่ตรงกับโปรเจกต์ไหนเลย → ไม่ error แต่โชว์หน้าเปล่าพร้อมปุ่ม "ดูทั้งเครื่องแทน"

### 4.4 หา port ว่าง

- default `--port 0` → `server.listen(0)` ให้ OS เลือก port ว่างให้ (**ไม่มี race condition**, ไม่ต้องไล่ scan เอง)
- ถ้า user ระบุ port มาแล้วชน `EADDRINUSE` → **error ทันที บอกว่าใครใช้อยู่** ไม่แอบเลื่อนไป port อื่น (แอบเลื่อน = user เปิดผิดหน้าแล้วงง)
- print URL ให้ครบ: `http://127.0.0.1:<port>` (bind `127.0.0.1` เท่านั้น — **ห้าม `0.0.0.0`** ข้อมูล usage/cost ไม่ควรออกนอกเครื่อง)
- เปิด browser: WSL2 ต้องลอง `wslview` → `explorer.exe` → `xdg-open` ตามลำดับ (เครื่องนี้เป็น WSL2)

### 4.5 หน้า HTML

| Section | เนื้อหา |
|---|---|
| Header | ขอบเขตที่ดูอยู่ (project path / "ทั้งเครื่อง"), ช่วงวันที่, ปุ่ม Refresh, toggle project ↔ all |
| Summary cards | cost รวม, token รวม, จำนวน session, agent ที่ใช้ |
| กราฟรายวัน | bar chart **SVG เขียนเอง** (ไม่มี lib) แกน x = วัน, y = cost, สีแยกตาม agent |
| ตารางโปรเจกต์ | (โหมด `--all`) เรียงตาม cost มาก→น้อย, คลิกแล้ว drill-in |
| ตาราง session | ชื่อจาก `aiTitle` (fallback = UUID 8 ตัวแรก), agent, model, token, cost, lastActivity |
| Model breakdown | จาก `modelBreakdowns[]` |
| Footer | เวอร์ชัน ccusage ที่ใช้ + เวลาที่เก็บข้อมูล |

- รองรับ **dark mode** ผ่าน `prefers-color-scheme`
- ตัวเลขเงินจัด `text-align: right` + ทศนิยม 2 ตำแหน่ง / token ใส่ตัวคั่นหลักพัน
- ตารางกว้างเกิน → ให้ container scroll แนวนอน **หน้าเว็บหลักห้าม scroll แนวนอน**

---

## 5. โครงไฟล์

```
ccusage-web/
├── PLAN.md                 # ไฟล์นี้
├── README.md               # วิธีใช้ (สั้น)
├── package.json            # bin: { "ccusage-web": "./dist/cli.js" }
├── tsconfig.json
├── src/
│   ├── cli.ts              # parse args → เรียก server/json mode
│   ├── ccusage.ts          # spawn ccusage + parse JSON + หา binary
│   ├── projects.ts         # scan ~/.claude/projects, decode path, อ่าน aiTitle/cwd
│   ├── report.ts           # join + aggregate เป็น report model
│   ├── server.ts           # node:http, listen(0), routes
│   ├── render/
│   │   ├── page.ts         # ประกอบ HTML
│   │   ├── chart.ts        # bar chart SVG
│   │   └── style.ts        # CSS inline (light/dark)
│   └── open.ts             # เปิด browser (wslview/explorer.exe/xdg-open)
└── test/
    ├── fixtures/           # JSON ตัวอย่างจาก ccusage จริง + jsonl ปลอม
    ├── projects.test.ts
    └── report.test.ts
```

---

## 6. Milestones

### M0 — Scaffold
- [ ] `npm init` + typescript + tsconfig (target ES2022, module NodeNext)
- [ ] `package.json`: `bin`, `files`, `engines: {node: ">=20"}`, `type: module`
- [ ] `.gitignore`, README ย่อ, MIT license
- [ ] สร้าง repo `ramath-x/ccusage-web` (public) + push

### M1 — Collector (พิสูจน์ว่าดูดข้อมูลได้)
- [ ] `ccusage.ts`: spawn + parse `--json --sections ...`
- [ ] resolve binary 3 ชั้น (PATH → node_modules/.bin → npx)
- [ ] จัดการ error: ไม่มี ccusage / exit != 0 / JSON พัง → ข้อความไทยที่บอกวิธีแก้
- [ ] **เกณฑ์ผ่าน:** `node dist/cli.js --json --all` พ่น JSON ที่มี session ครบเท่า `ccusage session --json`

### M2 — Project index + join (ฟีเจอร์แกน)
- [ ] `projects.ts`: scan dir, sessionId จากชื่อไฟล์, อ่าน `aiTitle` + `cwd` จากหัวไฟล์
- [ ] cache ตาม mtime
- [ ] `report.ts`: join `session[].period` ↔ sessionId → aggregate ต่อ project
- [ ] session ที่ join ไม่ติด → ถัง `unmapped` (**ห้ามทิ้งเงียบ** ต้องโชว์ยอด + เหตุผล)
- [ ] **เกณฑ์ผ่าน:** `Σ cost ทุก project + unmapped == Σ cost จาก ccusage ดิบ` (เพี้ยน = join พัง)

### M3 — Server + HTML
- [ ] `server.ts`: listen(0), bind 127.0.0.1, routes `/`, `/api/report`, `/api/refresh`
- [ ] `render/`: หน้า HTML self-contained + dark mode + SVG chart
- [ ] เปิด browser อัตโนมัติ (WSL2-aware) + `--no-open`
- [ ] **เกณฑ์ผ่าน:** `curl -s http://127.0.0.1:<port>` ได้ HTML ไม่ 500 และตัวเลขบนหน้าตรงกับ `/api/report`

### M4 — โหมดโปรเจกต์
- [ ] default = cwd, `--project <path>`, `--all`
- [ ] toggle บนหน้าเว็บ + drill-in จากตารางโปรเจกต์
- [ ] cwd ไม่ match → empty state พร้อมทางออก
- [ ] **เกณฑ์ผ่าน:** รันใน `~/unixdev/newcarfly-docker-laravel-12` ต้องได้เฉพาะ session ของโปรเจกต์นั้น

### M5 — เก็บงาน
- [ ] test: `projects.ts` (decode path lossy, ไม่มี cwd, jsonl พัง), `report.ts` (ยอดรวมตรง)
- [ ] README: screenshot + ตารางเปรียบเทียบกับ `ccusage` ดิบ + ข้อจำกัดข้อ 2
- [ ] `npm publish` → ใช้ `npx ccusage-web` ได้จริงจาก registry
- [ ] GitHub Actions: `tsc --noEmit` + test บน PR

---

## 7. Edge cases ที่ต้องกันตั้งแต่แรก

| กรณี | สิ่งที่ต้องทำ |
|---|---|
| ไม่มี `~/.claude/projects` | ยังทำงานได้ — ทุกอย่างเข้า `unmapped` + banner บอก |
| ไฟล์ jsonl พัง / บรรทัดไม่ใช่ JSON | ข้ามบรรทัดนั้น **ห้ามพังทั้ง process** |
| โปรเจกต์ชื่อมี `-` (เช่น `newcarfly-docker-laravel-12`) | ต้องใช้ `cwd` — เคสนี้คือกับดักหลัก (ข้อ 4.2) |
| session ไม่มี `metadata.lastActivity` (เช่น gemini) | เรียงลำดับด้วยค่าที่มี, โชว์ `—` แทน crash |
| ccusage ยิงเน็ตดึงราคาไม่ได้ | ส่ง `--offline` ให้อัตโนมัติเมื่อ retry รอบ 2 |
| ข้อมูลเยอะ (session หลายพัน) | จำกัดตารางหน้าแรก 200 แถว + ปุ่มโหลดเพิ่ม |
| ccusage เปลี่ยน JSON schema | validate key ที่ใช้จริงตอน parse → error บอกชัดว่า schema เปลี่ยน ไม่ใช่ `undefined` ลาม |
| ผู้ใช้กด Refresh รัวๆ | debounce + ถ้า collector ยังรันอยู่ ให้ reuse promise เดิม |

---

## 8. Non-goals (ตั้งใจไม่ทำ)

- ❌ ไม่คำนวณราคาเอง — เชื่อ `totalCost` จาก ccusage (มันดูแล pricing table ให้แล้ว)
- ❌ ไม่เก็บ DB / ไม่มี state ถาวร — อ่านสดทุกครั้ง
- ❌ ไม่รันเป็น daemon / ไม่ auto-start — สั่งเมื่อไหร่ก็เปิดตอนนั้น ปิดเทอร์มินัลคือจบ
- ❌ ไม่ทำ auth / ไม่เปิดออกนอก localhost
- ❌ ไม่ทำ MCP server (คนละเรื่องกับ planner-mcp — ยืมแค่โครงโปรเจกต์ TS)

---

## 9. ความเสี่ยง

| ความเสี่ยง | ผลกระทบ | ทางรับมือ |
|---|---|---|
| ccusage เปลี่ยน `--json` schema | join พังเงียบ | pin เวอร์ชันใน dependency + validate ตอน parse + test fixture จาก JSON จริง |
| ชื่อไฟล์ jsonl เลิกเป็น session UUID | ฟีเจอร์ per-project ตาย | มี fallback อ่าน `sessionId` จากในไฟล์ (ยืนยันแล้วว่า field นี้มีอยู่ทุกบรรทัด) |
| agent อื่นไม่มี project mapping | ตัวเลข per-project ไม่ครบ | โชว์ `unmapped` ตรงๆ อย่าเดา (ข้อ 2) |

---

## 10. Definition of Done

รันใน repo ไหนก็ได้:

```bash
npx ccusage-web
```

แล้วต้อง: เปิด browser ที่ port ว่างอัตโนมัติ → เห็น cost/token ของ **โปรเจกต์นั้น** ถูกต้อง →
กด toggle "ทั้งเครื่อง" เห็นทุกโปรเจกต์เรียงตาม cost → ยอดรวมตรงกับ `npx ccusage` เป๊ะ → ปิดด้วย Ctrl+C จบสะอาด
