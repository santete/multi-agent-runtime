# ADR-0027: Policy theo project

- Status: Accepted
- Date: 2026-10-01

## Context

Spec §47: policy có thể giới hạn repository, branch, thư mục, lệnh, network, secret, database và environment, tùy từng project. Spec §32: mỗi mức rủi ro do một vai trò khác nhau duyệt (CRITICAL cần owner của project).

Trước ADR này, policy (ADR-0004) là một bộ luật cố định dùng chung cho mọi project. HIGH luôn cần senior duyệt, còn CRITICAL luôn bị từ chối.

## Decision

`projects.policy` (`PUT /projects/:id/policy`, chỉ owner) gồm:

- **`rules`**: mỗi rule có `kind`, `pattern`, `action` và `reason`.
  - `kind` là `command` (regex trên lệnh shell), `write` (glob trên file agent ghi) hoặc `access` (glob trên file agent đọc hoặc ghi).
  - `action` là một trong:
    - `deny`: CRITICAL.
    - `approve`: deny HIGH, cần người duyệt.
    - `allow`: gỡ một yêu cầu duyệt của luật built-in, thành allow MEDIUM.
  - Thứ tự ưu tiên: deny trước approve, approve trước allow.
  - `allow` không bao giờ gỡ được: secret, `.git`, file ngoài worktree, hay một hành động CRITICAL built-in.
  - `allow` chỉ có tác dụng khi **mọi phần** bị chặn của call (từng đoạn lệnh, từng file) đều được một allow rule phủ. Ví dụ, allow `git rebase` không kéo theo việc cho phép `git reset --hard` nằm trong cùng lệnh.
- **`allowedHosts`**: các host mà lệnh network được gọi mà không cần duyệt (`*.example.com` gồm cả subdomain).
  - Cách kiểm bảo thủ: mỗi đoạn lệnh network phải có URL `http(s)://`, và mọi URL hay tên host trần trong đoạn đó đều phải thuộc danh sách.
  - `ssh`, `scp`, `nc` luôn cần duyệt.
  - `curl … | sh` vẫn là CRITICAL.
- **`approveMedium`**: khi bật, hành động MEDIUM (cài dependency) cũng cần duyệt.
- **`approvers`**: vai trò duyệt cho từng mức `MEDIUM`, `HIGH`, `CRITICAL`. Mặc định là member, senior, và `null` cho CRITICAL. `null` nghĩa là CRITICAL bị từ chối cứng như trước. Đặt `owner` thì CRITICAL đi qua approval gateway, như spec §32.

Policy được áp dụng ở cả hook trước tool (`tool-check`) lẫn audit sau khi chạy. Claim gửi kèm project, nên `TASK.md` liệt kê các rule, host được phép và yêu cầu duyệt cho agent biết trước. UI có tab **Policy** trên trang project: owner sửa được, những người khác chỉ xem.

Brief cũng dặn agent: action đã bị chặn chờ duyệt thì **không** hỏi lại trong `openQuestions`. Lý do: trong lần chạy thật, Claude vừa bị chặn vừa hỏi lại đúng chuyện đó, nên người phải trả lời hai lần.

## Consequences

- Path rule chỉ áp dụng cho file tool, tức các tool có đường dẫn file. Một lệnh shell như `cat customer-data/x` không bị path rule bắt. Muốn chặn trường hợp đó thì thêm một `command` rule.
- Regex của `command` rule do owner viết. API từ chối regex không hợp lệ, nhưng không bảo vệ trước regex chậm (ReDoS).
- Các mục spec §47 còn lại:
  - Secret: ADR sau.
  - Branch: platform tự quản lý push và merge, agent không push được.
  - Database và environment: được biểu diễn bằng `command` và `access` rule.
- Đã kiểm chứng thật trên `mar-sandbox` (LP-33, PR #35), với policy: `package.json` cần duyệt, host `registry.npmjs.org` được phép.
  - Claude chạy `curl https://registry.npmjs.org/left-pad/latest` và được allow MEDIUM ("network access to an allowed host").
  - Lệnh Edit `package.json` bị chặn ("project policy: dependency manifest changes need a person"). Lan (owner) duyệt, Claude resume và hoàn tất, rồi PR merge.
