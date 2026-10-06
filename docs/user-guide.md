# Hướng dẫn sử dụng

Tài liệu này dành cho người vận hành và người dùng hằng ngày: cài đặt, giao việc cho agent, theo dõi, can thiệp khi cần, và mở code trong IDE. Chi tiết từng API nằm trong [README](../README.md#api), còn lý do thiết kế nằm trong các [ADR](adr/).

> Ảnh minh hoạ trong tài liệu chụp từ một bộ dữ liệu demo (project `PAY Payments`), không phải repository thật.

## 1. Các thành phần

```text
 Người dùng ──► Dashboard / API ──► Control plane ──► Postgres
                                        ▲
                               claim / heartbeat / kết quả
                                        │
                 Runner (máy có cài agent) ──► Claude Code · Codex · Antigravity · CLI khác
                         │
                  git worktree theo từng task ──► push branch ──► GitHub (PR, CI, merge)
```

| Thành phần | Vai trò |
|---|---|
| **Control plane** | Quản lý project, task, plan, lịch chạy, policy, approval, merge queue, metric; phục vụ API và dashboard. Chạy được nhiều instance trên cùng một Postgres ([ADR-0033](adr/0033-leader-election.md)). |
| **Runner** | Nhận task, tạo worktree riêng cho mỗi task, chạy CLI agent ở chế độ headless, chạy validation (trên máy, hoặc trong container), push branch. |
| **Agent** | Claude Code, Codex, Antigravity (agy), Qoder (`qodercli`), Command Code (`command-code`), hoặc bất kỳ CLI nào qua adapter `generic-cli`. |

Platform **không cắm vào IDE**. Nó điều khiển bản CLI của các agent (`claude`, `codex`, `agy`, `qodercli`, `command-code`): runner gọi chúng, gắn policy hook, và đọc kết quả có cấu trúc. Người dùng làm việc qua dashboard; muốn xem code thì mở branch hoặc worktree trong IDE (xem [mục 7](#7-mở-code-trong-ide)).

## 2. Cài đặt và khởi động

Yêu cầu: Node 22+, pnpm 10, git. Thêm Docker nếu dùng Postgres. Mọi lệnh dưới đây chạy **ở thư mục gốc của repo**, và đường dẫn tương đối (`./users.json`, `runner.config.json`) tính từ thư mục đó.

**Bước 1: cài đặt và build dashboard**

```sh
pnpm install
pnpm --filter @mar/web build            # dashboard, phục vụ tại /ui/
```

**Bước 2: database.** Có hai lựa chọn:
- Không làm gì: control plane dùng PGlite nhúng (dữ liệu ở `apps/control-plane/.data/pglite`). Hợp để thử và dev, chỉ chạy được một instance.
- Postgres: `docker compose up -d` (dùng `docker-compose.yml` của repo, Postgres ở `localhost:5432`, user/mật khẩu/db đều là `mar`), rồi đặt `DATABASE_URL` ở bước 4.

**Bước 3: người dùng.** Tạo `users.json` ở thư mục gốc repo. File đã nằm trong `.gitignore`. Token dài ít nhất 16 ký tự:

```json
[
  { "name": "me",     "role": "owner",  "token": "đổi-thành-chuỗi-ngẫu-nhiên-1" },
  { "name": "laptop", "role": "runner", "token": "đổi-thành-chuỗi-ngẫu-nhiên-2" }
]
```

Có thể bỏ qua bước này khi chỉ thử trên máy mình. Khi đó API chạy ở *open mode*: ai gọi tới `127.0.0.1` cũng là owner, và không cần `apiToken` cho runner.

**Bước 4: control plane** (mặc định http://127.0.0.1:7700). Bỏ dòng `DATABASE_URL` nếu dùng PGlite.

PowerShell (Windows):

```powershell
$env:GITHUB_TOKEN   = gh auth token
$env:DATABASE_URL   = "postgres://mar:mar@localhost:5432/mar"
$env:MAR_USERS_FILE = "./users.json"
pnpm --filter @mar/control-plane start
```

cmd (Windows):

```bat
for /f %i in ('gh auth token') do set GITHUB_TOKEN=%i
set DATABASE_URL=postgres://mar:mar@localhost:5432/mar
set MAR_USERS_FILE=./users.json
pnpm --filter @mar/control-plane start
```

Trong cmd, `for /f` chạy lệnh `gh auth token` rồi gán kết quả vào biến (viết `%%i` nếu đặt trong file `.bat`). `GITHUB_TOKEN` lấy từ GitHub CLI đã đăng nhập (`gh auth login`), nên không phải tạo hay dán token ở đâu. Thiếu nó thì branch vẫn được push, chỉ là không có PR.

bash (Git Bash, macOS, Linux):

```sh
GITHUB_TOKEN=$(gh auth token) \
DATABASE_URL=postgres://mar:mar@localhost:5432/mar \
MAR_USERS_FILE=./users.json \
pnpm --filter @mar/control-plane start
```

Khởi động thành công thì log có dòng `Server listening at http://127.0.0.1:7700`, và `http://127.0.0.1:7700/health` trả `{"ok":true,"role":"leader"}` (vài giây đầu có thể là `standby`). Mở dashboard tại `http://127.0.0.1:7700/ui/` rồi đăng nhập bằng token owner. Nếu không lên được, control plane in **một dòng** nói rõ lỗi:

| Thông báo | Cách sửa |
|---|---|
| `Cannot connect to Postgres at localhost:5432/mar (ECONNREFUSED)` | Chạy `docker compose up -d`, hoặc bỏ `DATABASE_URL` để dùng PGlite |
| `MAR_USERS_FILE: … does not exist` | Sai đường dẫn: đường dẫn tương đối tính từ thư mục đang đứng lúc gõ lệnh |
| `MAR_USERS_FILE: …: 0.token: tokens must be at least 16 characters` | Sửa đúng trường được nêu |
| `Port 7700 on 127.0.0.1 is already in use` | Một control plane khác đang chạy: tắt nó, hoặc đặt `PORT` khác |
| `Refusing to listen on 0.0.0.0 without API users` | Mở ra mạng (`HOST`) thì bắt buộc có `users.json` |

**Bước 5: runner**, trên mỗi máy có agent, trong một terminal khác:

```sh
cp apps/runner/runner.config.example.json runner.config.json
# Sửa runner.config.json: giữ lại các agent đã cài trên máy này, thêm "apiToken": "<token của user role runner>"
pnpm --filter @mar/runner start runner.config.json
```

`home` trong config (mặc định `./.runner`, nơi chứa repo clone và worktree) tính từ thư mục chứa file config. Trên Windows, agent gọi `bash` (như agent `shell` trong config mẫu) chạy bằng Git Bash, kể cả khi `bash` trong PATH là WSL.

### Người dùng và vai trò

`MAR_USERS_FILE` là một mảng `{ name, role, token, org? }`. Các vai trò, từ thấp đến cao:

| Vai trò | Được làm |
|---|---|
| `viewer` | Xem |
| `member` | Tạo, huỷ, retry, review task; trả lời câu hỏi; gửi instruction |
| `senior` | Duyệt hành động rủi ro HIGH (mặc định) |
| `owner` | Cấu hình project, policy, secret |

Riêng `runner` là danh tính của máy chạy runner. User có org `"*"` là admin của toàn platform. Dashboard đăng nhập bằng token.

### Cấu hình runner

Trong `runner.config.json`, mỗi agent khai báo:

```json
"agents": {
  "claude-code": { "adapter": "claude-code", "skills": ["typescript", "backend", "review"], "cost": "high", "maxConcurrent": 1 },
  "codex":       { "adapter": "codex", "skills": ["typescript", "review"], "cost": "medium" },
  "antigravity": { "adapter": "antigravity", "executable": "C:/…/agy.exe", "unattended": false, "isolateConfig": true },
  "qoder":       { "adapter": "qoder", "executable": "C:/…/.qoder/bin/qodercli/qodercli.exe", "skills": ["typescript"], "cost": "medium" },
  "command-code": { "adapter": "command-code", "skills": ["typescript"], "cost": "low" },
  "shell":       { "adapter": "generic-cli", "command": "bash", "args": ["-c", "{objective}"] }
}
```

- `skills` dùng để route task có `agent: "auto"`. `cost` và `pricing` dùng để ước tính chi phí.
- Qoder báo chi phí bằng credit chứ không phải token hay USD, nên budget theo USD không tính được cho agent `qoder`. `tools` (tuỳ chọn) đổi danh sách tool khi agent sửa code; khi review hoặc lập plan, agent chỉ được đọc ([ADR-0035](adr/0035-qoder-adapter.md)).
- Command Code chỉ sửa được code khi runner bật policy hook (mặc định là bật). Khi đó policy là lớp quyết định mọi lời gọi. Taste learning được tắt trong các lượt chạy do platform điều phối ([ADR-0036](adr/0036-command-code-adapter.md)).
- `profile` (tuỳ chọn) lấy agent từ Marketplace: instructions, skills, giá.
- Máy runner cần **đăng nhập sẵn** các CLI và có quyền push lên repo. Agent không bao giờ được push hay giữ credential.

### Biến môi trường hay dùng

| Biến | Dùng để |
|---|---|
| `DATABASE_URL` | Postgres; nên đặt cho mọi môi trường dùng chung |
| `GITHUB_TOKEN` / `GITLAB_TOKEN` | Mở và merge PR/MR |
| `MAR_SECRETS_KEY` | Mã hoá secret của project |
| `MAR_NOTIFY_WEBHOOKS`, `MAR_NOTIFY_EVENTS` | Thông báo Slack/webhook chung của platform |
| `MAR_PUBLIC_URL` | Địa chỉ dashboard dùng trong link thông báo (đặt là địa chỉ load balancer khi chạy nhiều instance) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Gửi trace và metric qua OpenTelemetry |

## 3. Tạo và cấu hình project

Owner bấm **New project** trên trang Overview: điền tên, key (tiền tố của mã task, ví dụ `PAY`), repository (`owner/repo` trên GitHub hoặc URL clone) và các lệnh validation. Cũng có thể tạo qua API (`POST /projects` với `key`, `name`, `repoUrl`, `validation`). Sau đó cấu hình tiếp trên trang project:

| Ở đâu | Cấu hình gì |
|---|---|
| `validation` | Các lệnh phải pass sau khi agent làm xong (`npm test`…). Có thể chạy trong container (`validationSandbox`) |
| Review | Agent nào review chéo; agent duyệt thì có tự merge không (`autoApproveOnAgentReview`) |
| CI | Chờ CI của PR xanh mới merge; tự validate lại khi `main` đã đi tiếp |
| Tab **Costs** | Budget theo ngày và theo task |
| Tab **Plans** | Critic phản biện plan; plan nhỏ được tự duyệt |
| Tab **Policy** | Rule riêng của project, host được phép truy cập, ai duyệt mức rủi ro nào, **secret** |

![Tab Policy: rule, network, người duyệt, secret](images/guide-policy.png)

## 4. Giao việc

### Task lẻ

Bấm **New task** trên trang project:

![Form tạo task](images/guide-new-task.png)

- **Objective**: agent cần làm gì.
- **Agent**: một agent cụ thể, hoặc `auto` để scheduler chọn theo skill, độ tin cậy, chi phí và tải. Có thể khai báo agent dự phòng.
- **Acceptance criteria**: mỗi dòng một tiêu chí, phải kiểm chứng được. Agent tự báo từng tiêu chí; reviewer chấm lại, và còn tiêu chí chưa đạt thì **không merge được** ([ADR-0034](adr/0034-collaboration-contract.md)). Mục *More of the contract* có thêm expected output, constraints, inputs.
- **Area**: các file hoặc glob task sẽ sửa. Hai task có area chồng nhau thì chạy lần lượt, và agent ghi ra ngoài area của mình sang vùng của task khác sẽ cần người duyệt ([ADR-0026](adr/0026-path-ownership.md)).
- **Priority**, **Depends on**.

### Từ một mục tiêu (plan)

Bấm **New plan** và mô tả goal. Luồng diễn ra như sau:
1. Agent planner đọc code và chia goal thành các task, mỗi task có contract riêng.
2. Agent critic phản biện plan.
3. Người duyệt plan, có thể sửa từng task trước khi duyệt. Nếu project bật tự duyệt, plan nhỏ được critic chấp nhận sẽ tự chạy.

Việc chỉ người làm được (quyết định nghiệp vụ, cấp quyền, thao tác ngoài repo) trở thành **task cho người** (`agent: "human"`) trong Inbox. Câu trả lời của người được chuyển cho các task phụ thuộc.

### Vòng đời của một task

```text
READY → ASSIGNED → RUNNING → VALIDATING → REVIEW → APPROVED → MERGING → COMPLETED
                      │            └─ validation fail ─┐
                      ├─ cần người duyệt / có câu hỏi → WAITING_FOR_HUMAN
                      └─ Pause → PAUSED            REWORK ← review / CI / conflict
```

Task fail quá số lần cho phép thì chuyển sang `BLOCKED` và chờ người.

## 5. Theo dõi

### Overview và Board

![Overview](images/guide-overview.png)

**Overview** cho biết: số runner online, số agent đang làm việc, số approval đang chờ, tiến độ từng project, và dòng hoạt động gần đây.

![Board của project](images/guide-board.png)

**Board** chia task thành các cột:
- *Ready*: đúng thứ tự scheduler sẽ lấy, kèm điểm ưu tiên. Badge **waits for PAY-3** nghĩa là task đang chờ vì trùng area với PAY-3.
- *Working*, *Needs you*, *Rework*, *Merging*, *Done*.

Tab **Graph** vẽ dependency giữa các task; tab **Activity** là dòng sự kiện của project.

### Trang task

![Trang task đang chạy: console trực tiếp](images/guide-task-console.png)

- **Agent console** chiếu trực tiếp các message, tool call của agent và quyết định của policy (allowed/denied, mức rủi ro). Với agent chạy sandbox như Codex, tool call được kiểm tra sau khi chạy (audit).
- **Instructions**: gửi lời nhắn cho agent. Nếu agent đang chạy, mặc định nó dừng lại rồi resume **đúng session** với lời nhắn đó.
- **Pause / Resume / Cancel / Retry** nằm góc trên bên phải.

![Trang task đang chờ review: contract, review, handoff, diff](images/guide-task-contract.png)

Khi task đã có kết quả, trang task còn có:
- **Contract**: owner, inputs, constraints, expected output, và checklist tiêu chí. Checklist lấy kết quả chấm của reviewer; nếu chưa có review thì lấy kết quả agent tự báo.
- **Reviews** của agent và của người; **Handoff** (tóm tắt, thay đổi, quyết định, vấn đề còn lại).
- **Diff** của worktree sau mỗi lần chạy, kể cả khi agent bị dừng giữa chừng.
- **Validation** từng bước, **Timeline**, và các **Executions** (mỗi attempt có console riêng).
- Ở trạng thái `REVIEW`: ô comment và hai nút **Request changes** / **Approve & merge**.

### Agents, Costs, Metrics

![Agents](images/guide-agents.png)

**Agents** hiện thành tích của từng agent: số lần chạy, tỉ lệ thành công, rework, review bị từ chối, tỉ lệ cần người, chi phí. Trang này cũng có các runner đang online, khả năng của từng agent, task đang làm, và agent nào đang bị quota cooldown (có nút xoá cooldown).

![Metrics](images/guide-metrics.png)

**Metrics** là các chỉ số thành công của spec §64, xem theo project và khoảng thời gian:
- engineering: tỉ lệ thành công, validation, rework, thời gian hoàn tất;
- automation: tỉ lệ người phải can thiệp, tỉ lệ tự xử lý, tỉ lệ tự động hoàn toàn;
- collaboration, reliability, platform.

Rê chuột lên mỗi số để xem định nghĩa. **Costs** (trong project) so chi phí theo ngày và theo agent với budget.

### Thông báo và vận hành

- **Webhook** (Slack, Mattermost… hay bất kỳ endpoint nào nhận `{text}`): báo khi cần người (approval, review, plan, câu hỏi), khi task bị chặn, hết budget/quota, `main` bị hỏng sau merge. Mỗi org cấu hình được webhook riêng (`PUT /orgs/:id/notifications`).
- `GET /health` trả `role: "leader" | "standby"`. Leader là instance chạy việc nền (sweep, merge queue, thông báo).
- **OpenTelemetry**: mỗi execution là một trace (chuẩn bị workspace, chạy agent, từng bước validation, delivery). Metric có số execution, thời lượng, token, chi phí.
- Log JSON của control plane và runner.

## 6. Khi cần người can thiệp

![Inbox: câu hỏi của agent và approval](images/guide-inbox.png)

Mọi việc cần người đều nằm trong **Inbox**:

| Việc | Làm gì |
|---|---|
| **Câu hỏi của agent** (thiếu quyết định nghiệp vụ, hai tiêu chí mâu thuẫn) | Chọn một đáp án gợi ý hoặc tự trả lời. Agent resume đúng session với câu trả lời, và reviewer cũng thấy câu trả lời đó |
| **Approval**: agent muốn làm việc rủi ro (gọi mạng, sửa CI, ghi vào vùng của task khác, vi phạm rule của project) | *Approve* hoặc *Reject*. Agent resume và được báo kết quả. Mức rủi ro quyết định ai được duyệt |
| **Task cho người** | Làm việc đó rồi bấm *Done* kèm tóm tắt |
| **Stopped, nothing to approve**: task dừng vì một lời gọi bị từ chối hẳn (policy chặn, hoặc agent CLI tự chặn) nên không có gì để duyệt | Đọc lý do, rồi bấm *Retry* (chạy lại từ đầu) hoặc *Cancel task* |

Huỷ hoặc retry một task thì các approval và câu hỏi chưa ai trả lời của nó được rút khỏi Inbox (trạng thái `withdrawn`).

Các thao tác khác:
- **Agent đi sai hướng**: gửi *Instruction* trên trang task, hoặc *Pause* để xem diff trước.
- **Task `BLOCKED`**: đọc timeline và console, sửa contract hoặc gửi instruction, rồi *Retry*.
- **Review của người**: đọc checklist tiêu chí, diff và handoff, rồi *Approve & merge* hoặc *Request changes* (comment được chuyển cho agent làm rework).

## 7. Mở code trong IDE

- **Code đã giao**: checkout branch `task/<KEY>`, hoặc mở PR trên GitHub. PR có tóm tắt, quyết định, checklist tiêu chí và bảng kết quả validation.
- **Code đang làm dở**: worktree nằm trên máy runner, tại `<home>/worktrees/<KEY>`, mở bằng IDE như một thư mục bình thường. **Không sửa** khi agent đang chạy. Muốn chỉnh hướng thì dùng *Instruction*, hoặc *Pause* trước.
- Diff mới nhất của task luôn có trên trang task, kể cả khi không vào được máy runner.

## 8. Bảo mật trong một câu

Agent không push và không giữ credential. Mọi tool call đều đi qua policy (built-in cộng với rule của project), nên hành động rủi ro phải có người duyệt. Secret chỉ đến tay agent dưới dạng biến môi trường, được che trong mọi log, và diff chứa secret thì không được merge. Xem [ADR-0004](adr/0004-policy-enforcement.md), [ADR-0027](adr/0027-project-policy.md), [ADR-0029](adr/0029-secret-management.md).
