# ADR-0025: Tổ chức (multi-org) và agent marketplace

- Status: Accepted
- Date: 2026-10-01

## Context

Spec §49: platform phục vụ nhiều tổ chức. Mỗi tổ chức có project, agent và knowledge riêng. Agent có thể ở mức global, project hoặc task. Spec §53 (Phase 3) có "Organization-wide Agent Marketplace".

Trước ADR này, mọi người dùng thấy mọi thứ, và agent chỉ được định nghĩa trong config cục bộ của từng runner.

## Decision

### Tổ chức

- Bảng `orgs`. Mọi project và runner thuộc một org. Dữ liệu cũ thuộc org `default`.
- Mỗi user trong `MAR_USERS_FILE` có `org`, mặc định `default`. Org `*` là **platform admin**, thấy mọi org. Open mode và `MAR_API_TOKEN` là admin. Khi khởi động, control plane tự tạo các org có trong users file. Admin tạo thêm org qua `POST /orgs`.
- **Cách ly (kiểm ở API):**
  - Với mọi route dạng `/<resource>/:id` (projects, tasks, plans, executions, approvals, decisions, knowledge, runners, agent-profiles), cùng tham số `projectId` trên query, control plane tra org của tài nguyên. Nếu khác org của người gọi thì trả **404**, như thể tài nguyên không tồn tại.
  - Các danh sách (projects, runners, approvals, decisions, human-tasks, events/recent, stream, agents/stats, skill-stats, cooldowns) được lọc theo org.
- Người tạo project thì project thuộc org của họ. Chỉ admin chọn được org khác.
- **Runner** thuộc org của token nó dùng. Nó chỉ nhận task của project trong org đó, và planner, critic, auto-approve chỉ tính các agent online của org đó.
- **Agent theo project:** `allowedAgents` (`PUT /projects/:id/agents`). Khi danh sách này không rỗng, chỉ các agent trong đó được nhận task cố định và được auto routing chọn.

### Agent marketplace

- **Profile** (`agent_profiles`): `name`, `version` (mỗi lần publish thêm một version), `adapter`, `description`, `skills`, `cost`, `pricing`, `instructions`. Profile được publish vào org của người publish (role senior trở lên), hoặc **public** cho mọi org (chỉ admin). Profile có thể bị đánh dấu deprecated.
- **Dùng:** trong config runner, agent ghi `"profile": "name"` (bản mới nhất chưa deprecated) hoặc `"name@version"`. Khi runner đăng ký, control plane resolve profile: ưu tiên profile của org mình trước profile public, và kiểm tra adapter khớp. Những gì runner không tự đặt (skills, cost, pricing) được lấy từ profile, và agent mang theo `profile: "name@version"`.
- Mỗi execution ghi lại profile của agent đã chạy nó. Claim gửi `agentInstructions`, runner ghi ra `.orchestrator/context/AGENT.md`, và prompt nhắc agent làm theo các chỉ dẫn này. Áp dụng cho mọi loại task: work, review, plan, critique.
- **Usage:** mỗi profile có số lượt chạy, thành công và thất bại trên các project của org người xem.
- **UI:** trang Marketplace (catalog, usage, publish, deprecate). Trang Agents hiện profile của từng agent. Sidebar hiện org của người dùng.

## Consequences

- Cách ly được thực thi ở tầng API, không phải bằng row-level security trong DB. Mọi route mới cần có `/:id` hoặc filter theo org. Test `orgs.test.ts` canh cho các đường chính.
- Notifier, budget và knowledge vẫn theo project nên đã được cách ly theo org một cách tự nhiên. Riêng notifier dùng chung webhook cho mọi org; mỗi org một webhook là việc sau.
- Profile chỉ mô tả agent, không chứa credential. Đăng nhập CLI vẫn nằm trên máy runner.
- Đã kiểm chứng thật:
  - Một user ở org khác không thấy project, và truy cập trực tiếp nhận 404.
  - Agent Claude được build từ profile `careful-coder@1` đã làm theo instructions của profile (ghi CHANGELOG, PR #31). Usage của profile được ghi lại.
