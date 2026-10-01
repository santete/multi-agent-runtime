# ADR-0031: GitLab provider

- Status: Accepted (chưa chạy thật với GitLab)
- Date: 2026-10-01

## Context

Spec §33 (Git Integration) cần hỗ trợ cả GitHub lẫn GitLab. Đến ADR-0025, `GitProvider` mới có một cài đặt là GitHub: mở PR, merge, comment, trạng thái CI và base, revert. Runner push bằng git thường nên không phụ thuộc vào nơi host repo. Chỉ phần control plane gọi API là riêng cho GitHub.

## Decision

- **`GitLabProvider`** dùng REST API v4, cho gitlab.com hoặc GitLab tự host (`GITLAB_URL`), xác thực bằng header `PRIVATE-TOKEN` (`GITLAB_TOKEN`). Repo được nhận ra theo host. Project path có thể có subgroup (`group/sub/repo`) và được URL-encode làm id. Merge request đóng vai pull request, `iid` là số.

| `GitProvider` | GitLab |
|---|---|
| openPullRequest | `POST /merge_requests` (squash, xóa source branch). Nếu nhận 409 thì tìm MR đang mở của branch đó |
| mergePullRequest | đọc MR trước: `merged` thì trả về sha; `has_conflicts` là conflict; `detailed_merge_status` đang checking/unchecked/preparing là pending. Sau đó `PUT …/merge` (squash): 406 là conflict; 405, 409, 422 là pending |
| commentOnPullRequest | `POST …/notes` |
| pullRequestStatus | `head = mr.sha`; `behindBase` dựa trên `GET /repository/compare?from=head&to=target` có commit hay không; CI lấy từ commit statuses |
| commitChecks | `GET /repository/commits/:sha/statuses`: giữ status mới nhất theo tên (job chạy lại); `allow_failure`, `manual`, `skipped` không chặn merge |
| revertPullRequest | GitLab không có API revert MR, nên: tạo branch `revert-mr-N` từ target, `POST /repository/commits/:sha/revert` lên branch đó (sha là squash commit hoặc merge commit), rồi mở MR |

- **`RoutingGitProvider`**: cấu hình cả `GITHUB_TOKEN` lẫn `GITLAB_TOKEN` thì mỗi lời gọi đi tới provider có `handles(repoUrl)` khớp. Repo không provider nào nhận thì giống trường hợp chưa cấu hình gì: branch được push nhưng không có PR. Gọi merge cho repo đó thì báo lỗi rõ ràng.
- Runner không đổi gì: nó push qua `origin` bằng credential git của máy runner, nên máy runner cần quyền push lên GitLab (credential helper hoặc SSH key).

## Consequences

- Đã kiểm tra bằng test với API giả lập: nhận diện repo, mở MR và mở lại MR, các kết quả merge, CI, revert, và routing. **Chưa chạy thật trên một repo GitLab**, vì cần tài khoản và token. Khi có, cần chạy một lần trọn luồng: task → MR → CI → merge → (revert).
- Revert một merge commit thật (khi project không dùng squash) có thể cần `mainline`; trường hợp đó sẽ kiểm tra khi chạy thật.
- UI và notification vẫn gọi là "pull request #N", trong khi GitLab dùng "!N". Link vẫn trỏ đúng MR.
