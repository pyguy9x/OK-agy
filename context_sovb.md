# Context — Dự án Sổ Văn bản Đi (sovb)

Ngày cập nhật: 2026-10-19. Dùng file này để tiếp tục làm việc trong session sau.

## Mục tiêu
Trích dòng cuối mỗi sheet trong file `So VB di 2025-2030.xlsm`, đẩy lên Firebase, hiển thị dashboard realtime từ mọi máy.

## Cấu trúc hệ thống (đang chạy ổn định)

```
Excel (So VB di 2025-2030.xlsm) trên máy 192.168.1.49
        ↓ sovb-server.js quét mỗi 60s, chỉ push khi sheet thay đổi
   Firestore collection `so_vb_di` (project: layso-vt)
        ├─ dashboard-sovb-anywhere.html — đọc Firestore trực tiếp (mọi máy, mọi mạng)
        └─ SSE /api/stream → http://192.168.1.49:3080 (dashboard LAN, served từ sovb-server)
```

## File chính trong project (thư mục `OK`)
- `sovb-server.js` — server chính:
  - Quét Excel mỗi 60s (dùng `exceljs`), đọc dòng cuối mỗi sheet (chỉ tính cột A→I, bỏ cột J để lọc dòng ghost như "Hường BXDD" ở sheet `5.Quyết định`)
  - Skip sheet rỗng `Kangatang`
  - **Tự tìm file Excel** qua `findXlsm()`: env `SOVB_XLSM` → thư mục của script → thư mục hiện tại (cwd) → `D:\Sổ CV đi` (thư mục chuẩn, tên có dấu tiếng Việt) → `D:\Minhbe`. Khớp mọi file `So VB di*.xlsm` (case-insensitive). Không tìm thấy → báo lỗi rõ ràng thay vì crash lung tung
  - Chỉ push Firestore khi sheet có thay đổi (so sánh snapshot in-memory)
  - Có `seedFromFirestore()` lúc khởi động: đọc docs mới nhất mỗi sheet từ Firestore, nạp vào lastSnapshot → restart không sinh push trùng
  - Route HTTP: `/` (dashboard), `/api/latest` (JSON toàn bộ), `/api/stream` (SSE realtime). CORS `*` cho API.
  - JSON mỗi doc: `tenSheet, row, thoiGian, soKH, noiDung, ky, gui, thoiGianQuet`
  - Port 3080 (env `PORT`), chạy bằng `npm run sovb` hoặc PM2 (`pm2 start sovb-server.js --name sovb`)
- `dashboard-sovb.html` — dashboard LAN (server serve), có tìm kiếm + bộ lọc sheet/người ký
- `dashboard-sovb-anywhere.html` — dashboard độc lập đọc Firestore trực tiếp (không cần server):
  - Chế độ chính: Firestore realtime (firebase compat SDK 10.12.2), user dán apiKey/firebaseConfig (chấp nhận: apiKey thuần, JSON, khối `const firebaseConfig = {...}`) → parser tự suy ra projectId mặc định `layso-vt`
  - Config lưu localStorage (`sovb_cfg`), lần sau tự kết nối
  - Chế độ phụ (gập trong `<details>`): LAN qua server, URL lưu `sovb_lan`
  - Có tìm kiếm + lọc + highlight từ khóa + badge MỚI (nháy vàng 5s)
- `So VB di 2025-2030.xlsm` — nguồn dữ liệu
- `firebase-credentials.json` — service account (bypass rules)
- Cài thêm lib: `exceljs` (đã npm install)

## Quy tắc hiển thị dashboard (user yêu cầu)
- **Ưu tiên sheet 1-8, 14, 30 lên đầu** (đúng thứ tự), còn lại theo số tăng dần, sheet không có số xuống cuối
- **Số KH hiện luôn trên tiêu đề thẻ** (chữ đậm giữa tiêu đề)
- Tiêu đề mỗi thẻ một màu riêng (hash tên sheet → HSL)
- resize không đổi màu giữa các lần render

## Firestore hiện trạng
- Security rules (đã Publish, đã verify bằng REST test):
  - `so_vb_di`: allow read: if true, write: if false
  - Các collection khác (gồm `van_ban` — tin nhắn Zalo, 582 docs): chặn web read/write
- Mỗi sheet còn đúng 1 doc (đã dọn 39 doc rác ngày 19/10: doc trùng, doc test `209-BC "test"`, doc bị đẩy ngược)
- Trạng thái chuẩn: `1.Công văn` → 1082-CV/ĐU row 481, `2.Báo cáo` → 212-BC/ĐU row 95, `4.Thông báo` → 291-TB/ĐU row 143, `5.Quyết định` → 734-QĐ/ĐU row 332

## Bài học quan trọng (đừng lặp lại)
1. **Chỉ 1 máy chạy sovb-server** — máy có file Excel cập nhật. Nếu 2 máy chạy với 2 bản file khác nhau, máy file cũ sẽ "đẩy ngược" data cũ về Firestore (đây là nguyên nhân dashboard anywhere sai dữ liệu ngày 19/10). Chuyển máy chủ: tắt server cũ TRƯỚC khi bật mới.
2. **Rules test mode hết hạn 15/11/2026** — đã được thay bằng rules mới ở trên, không cần lo nữa.
3. Server dùng service account (`firebase-credentials.json`) nên bypass rules — không bao giờ bị deny.
4. `npm run` nhận tên script trong package.json KHÔNG phải tên file → chạy đúng là `node sovb-server.js` hoặc `npm run sovb`.
5. Trong Firestore mỗi doc `thoiGianQuet` là ISO string — orderBy desc dùng để lấy doc mới nhất mỗi sheet.

## Chưa làm / idea tiếp theo
- Trích xuất theo số văn bản (soKH lớn hơn) thay vì theo thời gian quét, tránh tranh chấp khi nhiều nguồn
- Thông báo đẩy (Telegram/Zalo) khi có văn bản mới
- Sheet mới trong Excel được server tự nhận diện khi quét (đã hỗ trợ động, chưa test)
- Không dùng được dashboard anywhere nếu máy không internet — cần LAN fallback khi offline (hiện chỉ chế độ Firestore hoặc LAN, đã có cả 2)
- Đọc trực tiếp file Excel qua LAN share nếu muốn nhiều máy cùng theo dõi (chưa triển khai)
