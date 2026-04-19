# Outlook Mail Organizer

Tự động phân loại email trong hộp thư Outlook cá nhân (outlook.com / hotmail.com) bằng **TypeScript + Microsoft Graph API**. Mỗi 6 tiếng, GitHub Actions sẽ chạy script, đọc tối đa 50 email **đã đọc** trong Inbox, rồi chuyển vào thư mục tương ứng (Banking/ACB, Banking/VCB, Promotions, Security, Newsletters, …) và gán **category** (tag màu) tương ứng trong Outlook.

---

## Kiến trúc ngắn gọn

- `src/auth.ts` — OAuth2 **Device Code Flow**, lưu/refresh token tự động.
- `src/rules.ts` — Các rule phân loại theo domain người gửi + từ khóa subject.
- `src/organizer.ts` — Fetch email đã đọc → phân loại → tạo folder (nếu chưa có) → move + set category → ghi log vào `logs/run-YYYY-MM-DD.json`.
- `.github/workflows/organizer.yml` — Cron mỗi 6 giờ (`0 */6 * * *` UTC).

### Cấu trúc thư mục trong Inbox

```
Inbox/
├── Banking/
│   ├── ACB
│   ├── MBBank
│   ├── Techcombank
│   ├── VIB
│   ├── VCB
│   └── VPBankS
├── Promotions/
├── Security/
└── Newsletters/
```

### Category tương ứng

| Nhóm         | Category           |
| ------------ | ------------------ |
| Banking      | Red category       |
| Promotions   | Yellow category    |
| Security     | Orange category    |
| Newsletters  | Blue category      |

---

## Setup

### Step 1: Đăng ký Azure App (làm 1 lần)

1. Mở https://portal.azure.com → **App registrations** → **New registration**.
2. Name: `outlook-organizer`.
3. Supported account types: chọn **"Personal Microsoft accounts only"** (bắt buộc — vì đây là tài khoản outlook.com, không phải Microsoft 365 work).
4. Redirect URI: **bỏ trống** (Device Code Flow không cần redirect).
5. Bấm **Register** → copy **Application (client) ID** — đây là `MS_CLIENT_ID`.
6. Vào **Authentication** → **Advanced settings** → bật **"Allow public client flows"** → **Save**.
7. Vào **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions** → tick `Mail.ReadWrite` và `offline_access` → **Add permissions** → **Grant admin consent** (nếu có).

### Step 2: Lấy token lần đầu (chạy local)

```bash
git clone https://github.com/namnt888/outlook-automation
cd outlook-automation
npm install
MS_CLIENT_ID=your-client-id npm run auth
```

Script sẽ in ra:
- URL để mở: `https://microsoft.com/devicelogin`
- Mã xác thực (`user_code`)

Mở URL, nhập mã, đăng nhập tài khoản `namnt05@outlook.com` và đồng ý quyền. Sau khi hoàn tất, file `token.json` sẽ được tạo ở thư mục gốc (chứa `access_token`, `refresh_token`, `expires_at`).

> ⚠️ `token.json` đã được gitignore. **Không** commit file này lên repo.

### Step 3: Set GitHub Secrets

Vào repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**, tạo 2 secrets:

| Secret name         | Value                                              |
| ------------------- | -------------------------------------------------- |
| `MS_CLIENT_ID`      | Application (client) ID từ Step 1.5                |
| `GRAPH_TOKEN_JSON`  | Toàn bộ nội dung file `token.json` (paste nguyên JSON) |

### Step 4: Test thủ công

Vào tab **Actions** → chọn workflow **Mail Organizer** → bấm **Run workflow** → chờ job chạy xong → xem log. Lần chạy đầu nên chạy dry-run trước bằng cách sửa tạm command trong workflow hoặc chạy local:

```bash
MS_CLIENT_ID=your-client-id npm run organize:dry
```

---

## Commands

| Lệnh                  | Mô tả                                                   |
| --------------------- | ------------------------------------------------------- |
| `npm run auth`        | Device Code Flow — lấy token lần đầu (chạy local).      |
| `npm run organize`    | Chạy thật: fetch 50 email đã đọc → phân loại → move.    |
| `npm run organize:dry`| Dry-run: chỉ log sẽ làm gì, không chuyển thư thật.      |
| `npm run typecheck`   | Check type với `tsc --noEmit`.                          |

---

## Notes

- Token được **refresh tự động** bằng `refresh_token` → không cần chạy lại `npm run auth` trừ khi token bị revoke hoặc đổi mật khẩu.
- Mỗi lần chạy xử lý **tối đa 50 email đã đọc** (`isRead eq true`) theo thứ tự cũ nhất trước. Email chưa đọc được giữ nguyên.
- Nếu gặp HTTP 429 (rate limit), client sẽ tự đọc header `Retry-After` và retry.
- Log chi tiết của từng lần chạy được ghi vào `logs/run-YYYY-MM-DD.json` (chỉ tồn tại trong runner; không commit).
- GitHub Actions free tier: 2000 phút/tháng. Mỗi run ~1–2 phút × 4 run/ngày ≈ 240 phút/tháng ✅.

---

## Thêm rule mới

Mở `src/rules.ts`, thêm một object vào mảng `RULES`:

```typescript
{
  id: "banking-hdbank",
  folder: "Banking/HDBank",
  category: "Red category",
  match: (from) => from.toLowerCase().includes("hdbank.com.vn"),
}
```

Script sẽ tự tạo thư mục `Banking/HDBank` trong Inbox lần đầu gặp rule này.
