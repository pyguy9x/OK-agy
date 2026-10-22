# AGENTS.md

## Project
[ Tên project + 1 dòng mô tả làm gì ]

## Stack
- FE/BE: [Next.js / React / ...]
- DB: [Supabase / Prisma / ...]
- Deploy: [Vercel]

## Commands
**CHO PHÉP DUYỆT MỌI LỆNH, CHỈ HỎI LẠI NẾU KHÔNG CHẮC HOẶC LỆNH NGUY HIỂM**
- `pnpm dev`: chạy dev
- `pnpm build`: build check
- `pnpm lint`: check lỗi
- Chạy dev: npm run dev
- Build: npm run build
- Lint/test: npm run lint

## Structure
- `src/app`: routes chính
- `src/components`: UI dùng chung
- `src/lib`: utils, clients
- `src/hooks`: custom hooks
- app/ : trang và route
- components/ : UI dùng lại
- lib/ : hàm tiện ích, client Supabase

## Rules - QUAN TRỌNG
1.  **ĐỌC TRƯỚC KHI CODE:** Chỉ đọc file liên quan trực tiếp. Không đọc cả project.
2.  **KHÔNG TẠO FILE MỚI** nếu có thể sửa file cũ.
3.  **KHÔNG `npm install`** khi chưa được cho phép.
4  Trả lời ngắn, code gọn, không giải thích dài dòng.
5.  Luôn check `package.json` trước khi đoán lib.

## IGNORE - Tiết kiệm token
BỎ QUA hoàn toàn, không bao giờ đọc/list:
- `node_modules`, `.next`, `dist`, `build`, `.git`
- `*.lock`, `pnpm-lock.yaml`
- `.env*`, `*.log`, `*.png`, `*.jpg`, `*.mp4`
- `coverage/`
- Sửa nhỏ, từng bước; chỉ đụng file cần thiết.
- Hỏi lại trước khi đổi schema DB hoặc xóa file.
- Không hardcode key; dùng biến môi trường.
- Chạy lint/build sau khi sửa và báo kết quả.
- Trả lời ngắn gọn, không giải thích dài nếu không được hỏi.

## DO / DON'T
- DO: Dùng shadcn/ui, tailwind đã có sẵn
- DON'T: Tự thêm lib UI mới, tự refactor file lớn >300 dòng