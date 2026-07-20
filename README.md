# ccusage-web

ดู usage/cost ของ coding agent CLI (Claude Code, Gemini CLI ฯลฯ) เป็น **หน้าเว็บ** แทนตารางในเทอร์มินัล
รันคำสั่งเดียว → เสิร์ฟ HTML บน **port ว่างอัตโนมัติ** → ดูได้ทั้งทีละโปรเจกต์และทั้งเครื่อง

```bash
npx ccusage-web            # โปรเจกต์ปัจจุบัน (cwd) — เปิด browser ให้อัตโนมัติ
npx ccusage-web --all      # ทั้งเครื่อง ทุกโปรเจกต์ ทุก agent
npx ccusage-web --no-open  # ไม่ต้องเปิด browser (ก็อป URL ไปเปิดเอง)
npx ccusage-web --port 4321  # ระบุ port เอง (ชนแล้ว error ชัดๆ ไม่แอบเปลี่ยน)
npx ccusage-web --json     # ไม่ยิง server — พ่น JSON ที่ join แล้วออก stdout
```

หน้าเว็บ bind ที่ `127.0.0.1` เท่านั้น ไม่เปิดออกนอกเครื่อง และ **ไม่มี resource ภายนอกเลย**
(CSS/JS inline หมด ไม่มี CDN ไม่มี font นอก) จึงใช้งานได้ตอนออฟไลน์

ต่อยอดจาก [`ccusage`](https://github.com/ryoppippi/ccusage) — ตัวเลขทั้งหมดมาจาก `ccusage --json`
ส่วนที่เพิ่มคือการ **map session → โปรเจกต์** (ccusage คืนแค่ session UUID) แล้ว render เป็น dashboard

> 🚧 อยู่ระหว่างพัฒนา — ดูขอบเขตงานและสถานะได้ที่ [PLAN.md](./PLAN.md)

## Status

| Milestone | สถานะ |
|---|---|
| M0 Scaffold | ✅ |
| M1 Collector | ✅ |
| M2 Project index + join | ✅ |
| M3 Server + HTML | ✅ |
| M4 โหมดโปรเจกต์ | ⬜ |
| M5 เก็บงาน / publish | ⬜ |

## License

MIT
