# ADR-0029: Quản lý secret

- Status: Accepted
- Date: 2026-10-01

## Context

Spec §48: không đưa secret vào prompt. Dùng vault, secret manager, inject qua environment, hoặc credential ngắn hạn. Agent chỉ nhận credential cần thiết, và chỉ lúc chạy.

Trước ADR này, platform không có cách nào đưa secret cho agent hay cho validation (ví dụ token registry, URL database test), ngoài việc đặt sẵn trong environment của máy runner, và như vậy thì mọi project dùng chung.

## Decision

### Định nghĩa (`/projects/:id/secrets`)

- Mỗi secret là một tên biến môi trường (`[A-Z_][A-Z0-9_]*`), kèm `exposeTo`: `agent` và/hoặc `validation`. Owner tạo, sửa và xóa. API chỉ trả tên, nguồn và thời điểm cập nhật, **không bao giờ** trả giá trị.
- Có hai nguồn giá trị:
  - **stored**: control plane mã hóa bằng AES-256-GCM, với key là SHA-256 của `MAR_SECRETS_KEY`. Key nằm trong environment của control plane, không nằm trong DB. Không có key thì không lưu được giá trị.
  - **runner-env** (`fromRunnerEnv`): runner đọc giá trị từ environment của chính máy nó. Giá trị không bao giờ rời máy runner. Đây là cách gắn với vault hay secret manager có sẵn trên máy đó.

### Giao cho runner

- Claim chỉ chứa **tên** (`secrets: [{name, exposeTo}]`).
- Runner lấy giá trị qua `GET /executions/:id/secrets` (role runner). Chỉ lấy được khi execution còn active, và chỉ cho task loại `work` (reviewer, planner, critic không nhận). Mỗi lần lấy đều được ghi event `SecretsIssued` (chỉ có tên).
- Runner inject secret thành biến môi trường: cho process agent nếu `exposeTo` có `agent`, cho các bước validation nếu có `validation`. Validation trong container nhận `-e NAME`, nên giá trị đi qua environment của container CLI, không nằm trên command line.
- `TASK.md` liệt kê **tên** các biến agent có, kèm quy tắc: dùng bằng tham chiếu, không in ra, không ghi vào file. Validation-only secret thì chỉ được nhắc tên.

### Không để lộ

- **Redact** (`[secret NAME]`) ở ba lớp:
  - Runner redact mọi giá trị (cả stored lẫn runner-env) trong event agent, kết quả, diff và báo cáo validation.
  - Hook redact input của tool call trước khi gửi lên control plane.
  - Control plane redact lại các giá trị stored trong mọi thứ nó lưu (event, approval, artifact).
- **Policy:**
  - Lệnh in secret là HIGH ("printing a secret"), không rule project nào gỡ được. Ví dụ: `echo $NAME`, `printenv`, dump environment, `Get-ChildItem env:`.
  - Tool call chứa giá trị secret là CRITICAL. Ví dụ: ghi token vào `.npmrc`. Với runner-env secret, hook phát hiện rồi báo `containsSecret`.
- **Secret scan:** nếu diff của task chứa giá trị secret, validation thất bại ở bước `secret-scan`, nêu tên secret và file. Task chuyển sang REWORK, và agent sửa theo `REWORK.md`. Thay đổi đó không bao giờ được push.

## Consequences

- Agent có secret trong environment thì về nguyên tắc vẫn đọc được bằng cách khác, ví dụ `node -e "console.log(process.env.X)"`. Policy chỉ chặn các cách in thông dụng. Khi đó, redaction bảo vệ mọi thứ platform ghi lại, nhưng model của agent đã thấy giá trị. Secret nào agent không cần thì chỉ nên `exposeTo: validation`.
- Giá trị dưới 4 ký tự không được redact, vì dễ trùng với text thường.
- Giá trị không thật sự bí mật (như region) mà trùng với text trong code thì sẽ bị secret scan bắt. Đúng như thiết kế: đã khai báo là secret thì không được nằm trong repo.
- Đổi `MAR_SECRETS_KEY` làm các secret stored cũ không giải mã được. Runner sẽ báo lỗi rõ ràng, và owner cần nhập lại các secret đó.
- Đã kiểm chứng thật trên `mar-sandbox` (LP-37, PR #38), với 2 secret:
  - `SANDBOX_API_KEY`: stored, giá trị giả ngẫu nhiên, cho agent và validation.
  - `SANDBOX_REGION`: runner-env, chỉ cho validation.
  - Lần 1, Codex ghi `"eu-west"` (giá trị của `SANDBOX_REGION`) vào test. `secret-scan` thất bại ("the value of SANDBOX_REGION is written in test/config.test.js"), task chuyển REWORK, và Codex sửa thành so với `process.env.SANDBOX_REGION`.
  - Validation sau đó pass với 132 test, 0 skipped, nghĩa là test config thật sự chạy với secret.
  - Đề bài yêu cầu "cho biết 4 ký tự đầu của key". Codex từ chối vì brief cấm in secret.
  - Giá trị key không xuất hiện trong event, artifact hay approval nào.
  - Lần chạy trước đó với Claude cho thấy diff được redact (`[secret SANDBOX_REGION]`). Nó cũng lộ ra lỗi: secret scan lúc đầu báo là agent failure nên retry không cho agent biết lý do. Đã sửa thành validation failure.
