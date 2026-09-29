# Product Specification — Multi-Agent Coding Orchestration Platform

**Document:** `product-spec.md`  
**Version:** 1.0  
**Status:** Draft  
**Product Type:** Coding Agent Orchestration / Agent Runtime Platform

---

# 1. Executive Summary

## 1.1 Product vision

Xây dựng một nền tảng điều phối nhiều coding agent hiện hữu, trong đó mỗi coding agent có thể đang chạy thông qua một IDE, CLI hoặc execution environment khác nhau, nhưng được tổ chức thành **một đội ngũ phát triển phần mềm thống nhất**.

Người dùng không cần quan tâm task đang được thực hiện bởi Claude Code, Codex CLI, Gemini CLI, Cursor, VS Code agent hay một coding agent nội bộ nào. Người dùng chỉ cần giao mục tiêu cho project.

Platform chịu trách nhiệm:

- Phân tích mục tiêu.
- Phân rã thành các task.
- Xây dựng dependency graph.
- Chọn coding agent phù hợp.
- Tạo và quản lý workspace riêng cho từng task.
- Điều phối các agent chạy song song hoặc tuần tự.
- Chia sẻ context, knowledge và artifact giữa các agent.
- Xử lý approval/human-in-the-loop.
- Kiểm tra kết quả.
- Yêu cầu rework khi cần.
- Quản lý Git branch/worktree/MR.
- Điều phối review, test và merge.
- Theo dõi trạng thái toàn bộ đội ngũ agent.

Mục tiêu cuối cùng là tạo ra trải nghiệm:

> **Nhiều IDE/CLI/agent khác nhau nhưng làm việc như những cộng sự trong cùng một software engineering team.**

---

# 2. Problem Statement

## 2.1 Context hiện tại

Tổ chức đã sở hữu nhiều coding agent và công cụ phát triển khác nhau.

Ví dụ:

- Claude Code CLI.
- Codex CLI.
- Gemini CLI.
- Cursor.
- VS Code + coding agent.
- Các IDE khác.
- Các custom coding agent nội bộ.
- Các agent chuyên biệt cho testing, code review, security hoặc documentation.

Các công cụ này hiện tại tồn tại tương đối độc lập.

Mỗi agent có:

- Session riêng.
- Context riêng.
- Workspace riêng.
- Tool riêng.
- Cách approval riêng.
- Cách quản lý process riêng.
- Cách trả kết quả riêng.

Điều này tạo ra tình trạng:

```text
                Project
                   |
       +-----------+-----------+
       |           |           |
       v           v           v
    Claude       Codex       Gemini
       |           |           |
    IDE/CLI      IDE/CLI      IDE/CLI
       |           |           |
       +-----------+-----------+
                   |
              Developer
```

Các agent có thể cùng tham gia một project nhưng chưa thực sự **làm việc như một team**.

---

# 3. Core Problem

Có 5 vấn đề lớn cần giải quyết.

## 3.1 Không có lớp điều phối chung

Mỗi agent nhận task độc lập.

Không có một control plane biết:

- Project đang làm gì.
- Có bao nhiêu task.
- Task nào phụ thuộc task nào.
- Agent nào đang xử lý task nào.
- Task nào có thể chạy song song.
- Task nào đang bị block.
- Task nào cần human approval.

---

## 3.2 Các agent không có shared context

Agent A có thể phân tích architecture nhưng Agent B không biết kết quả.

Agent B có thể sửa code nhưng Agent C không biết:

- Vì sao thay đổi được thực hiện.
- Business rule nào đã được phát hiện.
- Những constraint nào cần giữ.
- Những decision nào đã được đưa ra.

Kết quả là nhiều agent phải phân tích lại cùng một vấn đề.

---

## 3.3 Workspace bị cô lập nhưng thiếu quản lý

Nhiều agent cùng thao tác trên một repository có thể gây:

- Conflict.
- File overwrite.
- Git race condition.
- Commit nhầm.
- Branch contamination.
- Test environment conflict.
- Agent này phá state mà agent khác đang sử dụng.

Cần một cơ chế workspace isolation và lifecycle management.

---

## 3.4 Không có agent collaboration protocol

Các agent hiện tại chủ yếu giao tiếp thông qua:

- Prompt.
- Chat.
- File.
- Git commit.

Chưa có một protocol chuẩn để truyền:

- Findings.
- Architecture analysis.
- Decisions.
- Artifacts.
- Test results.
- Review comments.
- Known issues.
- Dependencies.

---

## 3.5 Không có closed-loop execution

Flow phổ biến hiện tại:

```text
Task
  ↓
Agent
  ↓
Code
  ↓
Done
```

Platform cần biến thành:

```text
Task
 ↓
Plan
 ↓
Assign
 ↓
Execute
 ↓
Artifact
 ↓
Validate
 ↓
Review
 ↓
Rework nếu cần
 ↓
Merge
 ↓
Update Project Knowledge
```

---

# 4. Product Goal

## 4.1 Primary goal

Biến nhiều coding agent độc lập thành một **virtual software engineering team**.

Mỗi agent vẫn giữ nguyên:

- IDE.
- CLI.
- Model.
- Tool.
- Execution environment.
- Subscription.
- Workflow đặc thù.

Nhưng bên ngoài chúng được quản lý bởi một orchestration layer thống nhất.

---

# 5. Product Principles

## 5.1 Agent-agnostic

Platform không phụ thuộc vào một vendor/model.

Có thể tích hợp:

```text
Claude Code
Codex
Gemini
Cursor
VS Code agents
Aider
OpenCode
Custom agents
Internal agents
```

Thông qua Adapter/Runtime interface.

---

## 5.2 Control Plane ≠ Coding Agent

Platform không nhằm thay thế coding agent.

Platform chịu trách nhiệm:

> What should be done, by whom, in what order, with what context and under what policy?

Coding agent chịu trách nhiệm:

> How to execute the assigned engineering task.

---

## 5.3 Human remains the authority

Agent có thể tự động hóa phần lớn engineering workflow nhưng các hành động có rủi ro cao phải có approval gateway.

Ví dụ:

- Force push.
- Delete production data.
- Database migration nguy hiểm.
- Infrastructure changes.
- Production deployment.
- Secret access.
- Destructive shell command.

---

## 5.4 Structured collaboration

Agent không giao tiếp chủ yếu bằng conversation tự do.

Collaboration phải được chuẩn hóa thành:

- Task.
- Artifact.
- Event.
- Decision.
- Finding.
- Dependency.
- Validation result.

---

## 5.5 Git-native

Git là một phần quan trọng của collaboration model.

Mọi coding task cần có:

- Branch/worktree.
- Commit.
- Diff.
- Test result.
- Review.
- Merge request.

---

# 6. Target User Experience

Người dùng có thể chỉ cần nhập:

> Implement chức năng refund cho payment service.

Platform tự động:

```text
Requirement
    ↓
Analyze Project
    ↓
Decompose Tasks
    ↓
Build Dependency Graph
    ↓
Select Agents
    ↓
Create Workspaces
    ↓
Execute
    ↓
Share Context
    ↓
Validate
    ↓
Review
    ↓
Rework nếu cần
    ↓
Merge
```

Người dùng không cần mở 5 terminal và tự copy context giữa các agent.

---

# 7. Target Operating Model

## 7.1 Logical team

Platform tổ chức agent thành các role logic.

Ví dụ:

```text
Software Engineering Team
|
+-- Architect Agent
+-- Backend Agent
+-- Frontend Agent
+-- Database Agent
+-- QA Agent
+-- Code Review Agent
+-- Security Agent
+-- Documentation Agent
```

Các role này không nhất thiết tương ứng 1:1 với model.

Một Claude Code session có thể đóng vai Backend Agent.

Một Codex session có thể đóng vai QA Agent.

---

# 8. Core Architecture

```text
+-----------------------------------------------------------+
|                         USER / TEAM                       |
|              Goal / Requirement / Issue                  |
+-------------------------------+---------------------------+
                                |
                                v
+-----------------------------------------------------------+
|                     CONTROL PLANE                         |
|                                                           |
|  Project Manager                                          |
|  Planner                                                  |
|  Task Decomposer                                          |
|  Dependency Engine                                        |
|  Scheduler                                                |
|  Agent Router                                             |
|  Policy Engine                                            |
+-------------------------------+---------------------------+
                                |
                                v
+-----------------------------------------------------------+
|                     AGENT RUNTIME                         |
|                                                           |
|  Session Manager                                          |
|  Lifecycle Manager                                        |
|  Workspace Manager                                        |
|  Approval Gateway                                         |
|  Event Manager                                            |
|  Execution Monitor                                        |
+-------------------------------+---------------------------+
                                |
                +---------------+---------------+
                |               |               |
                v               v               v
       +---------------+ +---------------+ +---------------+
       | Agent Adapter | | Agent Adapter | | Agent Adapter |
       | Claude        | | Codex         | | Gemini        |
       +-------+-------+ +-------+-------+ +-------+-------+
               |                 |                 |
               v                 v                 v
         Claude Code CLI    Codex CLI         Gemini CLI

                +--------------------------------+
                |        Workspace Layer          |
                | Git Worktree / Docker / VM     |
                +--------------------------------+

                +--------------------------------+
                |       Shared Context Layer     |
                | KB / Artifacts / Decisions    |
                +--------------------------------+

                +--------------------------------+
                |      Git / CI / Validation      |
                +--------------------------------+
```

---

# 9. Major Components

## 9.1 Control Plane

Control Plane là bộ não quản lý toàn bộ project.

Responsibilities:

- Project management.
- Requirement intake.
- Task decomposition.
- Dependency management.
- Scheduling.
- Agent selection.
- Policy enforcement.
- Workflow management.

Control Plane không trực tiếp viết code.

---

# 10. Project Manager

Project là đơn vị collaboration cao nhất.

Một Project chứa:

```text
Project
|
+-- Repository
+-- Requirements
+-- Tasks
+-- Agents
+-- Workspaces
+-- Knowledge
+-- Artifacts
+-- Decisions
+-- Events
+-- Policies
+-- Pipelines
```

---

# 11. Task Management

Task là đơn vị công việc mà agent có thể thực hiện.

Một task cần chứa:

```yaml
id: TASK-003
title: Implement refund API
project: PAYMENT
type: implementation

objective:
  Implement refund API based on approved architecture.

inputs:
  - TASK-001
  - TASK-002

dependencies:
  - TASK-001
  - TASK-002

required_capabilities:
  - dotnet
  - backend
  - api

workspace:
  isolation: git-worktree

validation:
  - build
  - unit-test
  - integration-test

outputs:
  - source-code
  - test-code
  - artifact
```

---

# 12. Task State Machine

```text
CREATED
   |
   v
READY
   |
   v
ASSIGNED
   |
   v
RUNNING
   |
   +---------------------+
   |                     |
   v                     v
WAITING             FAILED
   |                     |
   v                     v
RESUMED              RETRY
   |
   v
VALIDATING
   |
   +---------------------+
   |                     |
   v                     v
PASSED                FAILED
   |                     |
   v                     v
REVIEW                REWORK
   |                     |
   v                     +----> RUNNING
APPROVED
   |
   v
MERGED
   |
   v
COMPLETED
```

Additional states:

```text
WAITING_FOR_HUMAN
WAITING_FOR_DEPENDENCY
WAITING_FOR_AGENT
CANCELLED
BLOCKED
```

---

# 13. Task Dependency Graph

Tasks phải được biểu diễn dưới dạng DAG.

Ví dụ:

```text
TASK-001
Architecture Analysis
      |
      +------------+
      |            |
      v            v
TASK-002        TASK-003
DB Design       API Design
      |            |
      +------┬-----+
             v
          TASK-004
        Implementation
             |
             v
          TASK-005
            Tests
             |
             v
          TASK-006
           Review
             |
             v
          TASK-007
           Merge
```

Scheduler có thể chạy TASK-002 và TASK-003 song song.

---

# 14. Agent Registry

Platform cần duy trì một registry mô tả các agent.

Ví dụ:

```yaml
agent:
  id: claude-code-01
  provider: anthropic
  runtime: claude-code-cli

capabilities:
  - architecture
  - code-analysis
  - backend
  - frontend
  - refactoring
  - testing

languages:
  - csharp
  - typescript
  - python

tools:
  - git
  - terminal
  - docker

modes:
  - autonomous
  - interactive

workspace:
  type: local
```

Agent registry không chỉ lưu tên model.

Nó phải mô tả **khả năng thực thi thực tế**.

---

# 15. Agent Capability Model

Capability có thể gồm:

```text
Language
Framework
Domain
Task Type
Tool
Environment
Security Level
Execution Mode
Cost Model
Latency
Reliability
Human Approval Requirement
```

Ví dụ:

```text
Agent A:
.NET + Backend + Refactoring

Agent B:
React + Frontend

Agent C:
Testing + Playwright

Agent D:
Security Analysis
```

Scheduler sử dụng capability để route task.

---

# 16. Agent Adapter

Mỗi coding agent được tích hợp qua Adapter.

Chuẩn hóa interface:

```text
start()
stop()
pause()
resume()
sendTask()
sendContext()
getStatus()
getOutput()
getLogs()
handleApproval()
cancel()
```

Ví dụ:

```text
AgentRuntime
|
+-- ClaudeCodeAdapter
+-- CodexAdapter
+-- GeminiAdapter
+-- CursorAdapter
+-- CustomAgentAdapter
```

Adapter chịu trách nhiệm chuyển interface chuẩn của platform sang interface riêng của agent.

---

# 17. Agent Runtime

Agent Runtime chịu trách nhiệm lifecycle.

```text
CREATE SESSION
      |
      v
PREPARE WORKSPACE
      |
      v
LOAD CONTEXT
      |
      v
START AGENT
      |
      v
MONITOR
      |
      +----> APPROVAL
      |
      +----> ERROR
      |
      +----> COMPLETE
      |
      v
COLLECT ARTIFACTS
      |
      v
VALIDATE
      |
      v
TERMINATE
```

---

# 18. Workspace Management

Mỗi task cần workspace isolation.

Không khuyến khích nhiều agent trực tiếp sửa cùng một working directory.

Mô hình:

```text
Project Repository
|
+-- main
|
+-- worktree/TASK-001
+-- worktree/TASK-002
+-- worktree/TASK-003
```

Có thể triển khai bằng:

- Git Worktree.
- Docker.
- Dev Container.
- VM.
- Remote development environment.

---

# 19. Workspace Lifecycle

```text
TASK CREATED
     |
     v
CREATE WORKSPACE
     |
     v
CHECKOUT BRANCH
     |
     v
INITIALIZE ENVIRONMENT
     |
     v
RUN AGENT
     |
     v
COLLECT CHANGES
     |
     v
VALIDATE
     |
     v
CREATE MR
     |
     v
MERGE
     |
     v
ARCHIVE / DELETE WORKSPACE
```

---

# 20. Shared Context Layer

Đây là thành phần giúp các agent hoạt động như cùng một team.

Shared Context gồm:

```text
Project Context
|
+-- Architecture
+-- Business Rules
+-- API Contracts
+-- Database Schema
+-- Coding Standards
+-- ADR
+-- Known Issues
+-- Task History
+-- Agent Findings
+-- Test Results
+-- Review Results
+-- Decisions
```

---

# 21. Context Flow

Ví dụ Architect Agent phân tích:

```text
Repository
    |
    v
Architect Agent
    |
    v
Architecture Analysis
    |
    v
Context Store
```

Backend Agent sau đó:

```text
Context Store
    |
    +-- Architecture
    +-- Business Rules
    +-- API Contract
    |
    v
Backend Agent
```

Backend Agent không cần phân tích lại toàn bộ project.

---

# 22. Structured Artifact

Agent collaboration phải ưu tiên artifact có cấu trúc.

Ví dụ:

```json
{
  "artifactType": "architecture_analysis",
  "taskId": "TASK-001",
  "findings": [
    {
      "component": "RefundService",
      "location": "src/Payment/RefundService.cs",
      "description": "Existing refund flow..."
    }
  ],
  "dependencies": [
    "TransactionRepository"
  ],
  "risks": [
    "Idempotency must be preserved"
  ]
}
```

Artifact types có thể gồm:

```text
architecture_analysis
api_contract
database_design
implementation_plan
code_change
test_result
review_result
security_finding
decision
documentation
```

---

# 23. Agent Collaboration Protocol

Agent không nên truyền thông tin cho nhau bằng chat tự do.

Thay vào đó:

```text
Agent A
   |
   v
Artifact
   |
   v
Context Store
   |
   v
Task Dependency
   |
   v
Agent B
```

Ví dụ:

```text
Architect Agent
    |
    +--> architecture_analysis
    |
    +--> api_contract
    |
    v
Backend Agent
```

---

# 24. Event-Driven Architecture

Platform nên sử dụng event-driven model.

Các event quan trọng:

```text
ProjectCreated
TaskCreated
TaskReady
TaskAssigned
AgentStarted
AgentStopped
AgentToolCalled
ApprovalRequested
ApprovalGranted
ApprovalRejected
ArtifactCreated
ValidationStarted
ValidationPassed
ValidationFailed
ReviewRequested
ReviewCompleted
TaskBlocked
TaskCompleted
MergeRequested
MergeCompleted
```

Event store phục vụ:

- Audit.
- Monitoring.
- Debugging.
- Replay.
- Analytics.
- Agent performance measurement.

---

# 25. Scheduler

Scheduler quyết định task nào được thực thi và agent nào thực thi.

Input:

```text
Task Requirements
+
Dependency Status
+
Agent Capabilities
+
Agent Availability
+
Workspace Availability
+
Policy
```

Output:

```text
Task -> Agent -> Workspace
```

Ví dụ:

```text
Task:
"Implement .NET refund API"

Required:
- C#
- .NET
- Backend
- API

Available:
Claude Code
Codex
Gemini

Scheduler:
=> Agent có capability phù hợp nhất theo policy hiện tại.
```

Scheduler không nên hard-code:

```text
.NET => Claude
```

Mà nên sử dụng capability và policy.

---

# 26. Parallel Execution

Platform phải hỗ trợ parallel execution.

Ví dụ:

```text
                Architecture
                     |
          +----------+----------+
          |                     |
          v                     v
      DB Design             API Design
          |                     |
          +----------+----------+
                     |
                     v
               Implementation
                     |
                     v
                   Tests
```

Các task không có dependency có thể chạy song song.

---

# 27. Conflict Management

Parallel execution phải kiểm soát conflict.

Các chiến lược:

```text
File ownership
Path ownership
Domain ownership
Git conflict detection
Dependency locking
Task-level locking
Resource locking
```

Ví dụ:

```text
TASK-001 owns:
src/Payment/**

TASK-002 owns:
src/Customer/**
```

Nếu hai task cùng sửa một file:

```text
Conflict detected
      |
      v
Orchestrator
      |
      +--> Serialize
      +--> Reassign
      +--> Merge
      +--> Human Review
```

---

# 28. Validation Layer

Agent hoàn thành không đồng nghĩa task hoàn thành.

Validation pipeline:

```text
Build
  ↓
Unit Test
  ↓
Integration Test
  ↓
Lint
  ↓
Static Analysis
  ↓
Security Scan
  ↓
Architecture Rules
  ↓
Business Rule Validation
```

---

# 29. Automatic Rework

Nếu validation fail:

```text
Agent
  |
  v
Implementation
  |
  v
Validator
  |
  v
FAIL
  |
  v
Generate Rework Context
  |
  v
Agent Resume
```

Ví dụ:

```text
Integration test failed:
Refund request creates duplicate transaction.

Orchestrator:
Create rework instruction.

Agent:
Investigate idempotency handling.
```

---

# 30. Review Agent

Review có thể được thực hiện bởi một agent khác với agent implementation.

Ví dụ:

```text
Codex
  |
  v
Implementation
  |
  v
Claude Reviewer
  |
  v
Review Result
```

Review không chỉ kiểm tra syntax.

Có thể kiểm tra:

```text
Correctness
Architecture
Security
Performance
Maintainability
Coding Convention
Test Coverage
Business Rules
```

---

# 31. Human-in-the-loop

Platform cần Approval Gateway.

Flow:

```text
Agent
   |
   v
High-risk action
   |
   v
Approval Gateway
   |
   v
Slack / Telegram / Web
   |
   +---- Approve
   |
   +---- Reject
   |
   +---- Modify instruction
   |
   v
Resume Agent
```

Ví dụ:

```text
Agent requests:

git push --force origin main

Risk:
HIGH

[Approve] [Reject]
```

Approval phải được audit.

---

# 32. Approval Policy

Policy có thể phân cấp:

```text
LOW
  Auto approve

MEDIUM
  Team member approval

HIGH
  Senior developer approval

CRITICAL
  Explicit project owner approval
```

Ví dụ:

```text
Read source code
=> Auto

Run tests
=> Auto

Modify production config
=> Approval

Delete production data
=> Mandatory approval
```

---

# 33. Git Integration

Git là collaboration backbone.

Platform cần quản lý:

```text
Repository
Branch
Worktree
Commit
Diff
Merge Request
Review
Merge
Conflict
Rollback
```

Flow:

```text
Task
 ↓
Create branch
 ↓
Create worktree
 ↓
Agent coding
 ↓
Commit
 ↓
Push
 ↓
Create MR
 ↓
Validation
 ↓
Review
 ↓
Merge
```

---

# 34. CI/CD Integration

Platform có thể tích hợp:

```text
GitLab CI
GitHub Actions
Jenkins
Azure DevOps
Custom CI
```

CI result trở thành một artifact/event.

```text
CI Started
    ↓
CI Passed / Failed
    ↓
Task State Update
```

---

# 35. Project Knowledge Lifecycle

Project Knowledge không phải dữ liệu tĩnh.

Lifecycle:

```text
Repository
    ↓
Analysis
    ↓
Knowledge
    ↓
Documentation
    ↓
New Development
    ↓
New Findings
    ↓
Knowledge Update
```

Đây là closed loop.

Mọi task có thể tạo thêm knowledge.

---

# 36. Planner

Planner nhận yêu cầu cấp cao:

```text
"Implement refund capability."
```

Planner tạo execution plan:

```text
1. Analyze current payment flow
2. Identify refund domain
3. Design database changes
4. Design API
5. Implement backend
6. Implement frontend
7. Add tests
8. Review
9. Integration test
10. Merge
```

Planner không nên trực tiếp thực hiện code.

---

# 37. Task Decomposer

Task Decomposer biến plan thành task có thể assign.

Mỗi task phải trả lời:

```text
What?
Why?
Input?
Output?
Dependency?
Required capability?
Validation?
Owner?
Workspace?
```

---

# 38. Agent Router

Agent Router chọn executor.

Input:

```text
Task
Capabilities
Agent Availability
Policy
Workspace
Cost
Performance
```

Output:

```text
Selected Agent
```

Có thể hỗ trợ policy:

```text
Prefer existing subscription
Prefer local execution
Prefer specialized agent
Prefer fastest available agent
Require secure agent
Require human approval
```

---

# 39. Cost and Resource Management

Platform cần tracking:

```text
Agent
Session
Task
Token usage
Execution time
API cost
Infrastructure cost
Retries
Failures
```

Đối với subscription-based agent, cost model có thể không phải token cost trực tiếp.

Platform vẫn cần theo dõi:

```text
Concurrency
Quota
Session duration
Resource usage
```

---

# 40. Agent Performance

Platform có thể đo:

```text
Task Completion Rate
Task Success Rate
Rework Rate
Average Execution Time
Validation Pass Rate
Review Rejection Rate
Retry Rate
Human Intervention Rate
```

Không nên chỉ dùng model benchmark.

Đánh giá dựa trên **thực tế project execution**.

---

# 41. Observability

Mỗi execution cần trace:

```text
Project
  ↓
Task
  ↓
Agent Session
  ↓
Tool Calls
  ↓
Artifacts
  ↓
Validation
  ↓
Review
  ↓
Merge
```

Có thể dùng:

```text
OpenTelemetry
Prometheus
Grafana
ELK
```

---

# 42. UI

Dashboard cần thể hiện:

## Project Overview

```text
Project: Payment Platform

Tasks:
  18 total
  8 running
  5 completed
  3 blocked
  2 waiting approval
```

## Agent Overview

```text
Claude Code
  RUNNING - TASK-003

Codex
  RUNNING - TASK-004

Gemini
  IDLE

QA Agent
  RUNNING - TASK-005
```

## Task Graph

Hiển thị dependency graph.

## Execution Timeline

Hiển thị event timeline.

---

# 43. Agent Console

Người dùng có thể xem:

```text
Agent:
Claude Code

Task:
TASK-003

Status:
RUNNING

Workspace:
worktree/TASK-003

Current action:
Running integration tests

Last artifact:
implementation_result

Pending:
Validation
```

Có thể:

```text
Pause
Resume
Cancel
Send instruction
Approve
Reject
Open workspace
Open diff
```

---

# 44. Team-like Interaction Model

Mục tiêu UX là:

```text
User
 |
 +-- Architect Agent
 |      "Architecture analysis completed."
 |
 +-- Backend Agent
 |      "API implementation completed."
 |
 +-- QA Agent
 |      "2 integration tests failed."
 |
 +-- Reviewer Agent
 |      "Found an idempotency issue."
 |
 +-- Backend Agent
        "Fix applied and tests passed."
```

Người dùng cảm nhận đây là **một team**, không phải nhiều tool rời rạc.

---

# 45. Agent-to-Agent Handoff

Ví dụ:

```text
Architect
   |
   | architecture_analysis
   v
Backend
   |
   | implementation
   v
QA
   |
   | test_result
   v
Reviewer
   |
   | review_result
   v
Backend
```

Mỗi handoff phải có:

```text
Source
Target
Task
Context
Artifact
Expected Action
Acceptance Criteria
```

---

# 46. Failure Handling

Agent có thể:

- Crash.
- Timeout.
- Mất session.
- Hết quota.
- Không hiểu task.
- Tạo code không build.
- Bị approval block.
- Workspace lỗi.

Platform phải có:

```text
Retry
Resume
Reassign
Rollback
Escalate
Human intervention
```

Ví dụ:

```text
Claude unavailable
       |
       v
Scheduler
       |
       +--> Reassign to Codex
       |
       +--> Wait
       |
       +--> Human decision
```

---

# 47. Security Model

Security boundaries:

```text
User
  ↓
Project
  ↓
Task
  ↓
Agent
  ↓
Workspace
  ↓
Tools
```

Mỗi agent không mặc nhiên được quyền truy cập mọi resource.

Policy có thể giới hạn:

```text
Repository
Branch
Directory
Command
Network
Secret
Database
Environment
```

---

# 48. Secret Management

Không nên đưa secret trực tiếp vào prompt.

Nên dùng:

```text
Vault
Cloud Secret Manager
Environment Injection
Short-lived Credential
```

Agent chỉ nhận credential cần thiết trong runtime.

---

# 49. Multi-project Support

Platform phải hỗ trợ nhiều project:

```text
Organization
|
+-- Project A
|    +-- Agents
|    +-- Tasks
|    +-- Knowledge
|
+-- Project B
|    +-- Agents
|    +-- Tasks
|    +-- Knowledge
|
+-- Project C
```

Agent có thể được:

```text
Global
Project-level
Task-level
```

---

# 50. Multi-agent Concurrency

Một project có thể:

```text
10 tasks
5 agents
3 IDE
7 CLI sessions
```

Platform phải quản lý:

```text
Concurrency
Queue
Resource limit
Workspace limit
Agent quota
CPU/Memory
```

---

# 51. MVP

MVP không nên cố giải quyết toàn bộ agentic software engineering.

## MVP Scope

### Project

- Create project.
- Connect Git repository.

### Task

- Create task.
- Assign task.
- Task dependency.

### Agent

- Agent registry.
- Claude Code adapter.
- Codex adapter.
- Generic CLI adapter.

### Runtime

- Start.
- Stop.
- Pause.
- Resume.
- Logs.

### Workspace

- Git Worktree.
- Isolated workspace.

### Context

- Task context.
- Artifact sharing.

### Validation

- Build.
- Test.
- Git diff.

### Git

- Branch.
- Commit.
- MR.

### Approval

- Basic approval gateway.

### UI

- Project dashboard.
- Task board.
- Agent status.
- Execution log.

---

# 52. Phase 2

```text
Advanced Scheduler
+
Dependency DAG
+
Parallel Execution
+
Automatic Rework
+
Review Agent
+
Shared Knowledge Base
+
Slack / Telegram
+
OpenTelemetry
+
Advanced Policy
```

---

# 53. Phase 3

```text
Autonomous Planning
+
Dynamic Agent Selection
+
Multi-agent Debate
+
Self-healing workflow
+
Automatic task reprioritization
+
Cost optimization
+
Agent performance optimization
+
Organization-wide Agent Marketplace
```

---

# 54. Example End-to-End Scenario

Requirement:

> Thêm chức năng refund cho Payment Service.

## Step 1 — Planning

Planner:

```text
Analyze payment architecture
Design refund domain
Design database
Design API
Implement backend
Write tests
Review
Integration test
```

## Step 2 — Decomposition

```text
TASK-001 Architecture
TASK-002 Domain
TASK-003 DB
TASK-004 API
TASK-005 Backend
TASK-006 Test
TASK-007 Review
TASK-008 Integration
```

## Step 3 — Scheduling

```text
TASK-001 -> Claude
TASK-002 -> Claude
TASK-003 -> Codex
TASK-004 -> Codex
TASK-005 -> Codex
TASK-006 -> QA Agent
TASK-007 -> Review Agent
TASK-008 -> QA Agent
```

## Step 4 — Parallel Execution

```text
TASK-002
TASK-003
TASK-004
```

có thể chạy song song nếu dependency cho phép.

## Step 5 — Context Handoff

Architecture Agent tạo:

```text
architecture_analysis
```

Backend Agent consume artifact đó.

## Step 6 — Implementation

Backend Agent sửa code trong:

```text
worktree/TASK-005
```

## Step 7 — Validation

```text
Build       PASS
Unit Test   PASS
Integration FAIL
```

## Step 8 — Rework

Orchestrator chuyển task về:

```text
REWORK
```

và gửi failure context cho Backend Agent.

## Step 9 — Review

Reviewer Agent kiểm tra diff.

## Step 10 — Merge

Khi:

```text
Build PASS
Test PASS
Review PASS
Policy PASS
```

MR được merge.

## Step 11 — Knowledge Update

Platform cập nhật:

```text
Architecture
API Contract
Decision
Implementation Finding
Test Result
```

vào project context.

---

# 55. Non-functional Requirements

## Performance

Platform phải có khả năng quản lý nhiều agent session đồng thời.

## Reliability

Orchestrator phải có khả năng resume workflow sau failure.

## Auditability

Mọi action quan trọng phải có event/audit record.

## Security

Agent phải chạy trong permission boundary.

## Extensibility

Thêm agent mới không được yêu cầu thay đổi core orchestration engine.

## Observability

Mọi execution phải có trace/log/metric.

## Recoverability

Workflow phải có checkpoint để resume.

---

# 56. Key Domain Model

Các entity chính:

```text
Organization
Project
Repository
Agent
AgentAdapter
AgentSession
AgentCapability
Workspace
Task
TaskDependency
Workflow
Artifact
Context
Decision
Approval
Policy
Validation
Review
MergeRequest
Event
Execution
```

Relationship:

```text
Project
 |
 +-- Tasks
 |    |
 |    +-- Dependencies
 |    +-- Execution
 |    +-- Artifacts
 |
 +-- Agents
 |    |
 |    +-- Sessions
 |    +-- Capabilities
 |
 +-- Workspaces
 |
 +-- Context
 |
 +-- Policies
 |
 +-- Events
```

---

# 57. Core API Concept

Ví dụ:

```http
POST /projects
POST /projects/{id}/tasks
POST /tasks/{id}/assign
POST /tasks/{id}/execute
POST /tasks/{id}/pause
POST /tasks/{id}/resume
POST /tasks/{id}/cancel

GET /projects/{id}/tasks
GET /projects/{id}/agents
GET /tasks/{id}/execution
GET /tasks/{id}/artifacts

POST /approvals/{id}/approve
POST /approvals/{id}/reject

GET /projects/{id}/events
```

---

# 58. Adapter Contract

Conceptual interface:

```csharp
public interface IAgentAdapter
{
    Task<AgentSession> StartAsync(
        AgentExecutionContext context);

    Task SendTaskAsync(
        AgentSession session,
        AgentTask task);

    Task PauseAsync(
        AgentSession session);

    Task ResumeAsync(
        AgentSession session);

    Task StopAsync(
        AgentSession session);

    Task<AgentStatus> GetStatusAsync(
        AgentSession session);

    Task<AgentOutput> GetOutputAsync(
        AgentSession session);
}
```

Adapter cụ thể:

```text
ClaudeCodeAdapter
CodexAdapter
GeminiAdapter
CursorAdapter
GenericCliAdapter
```

---

# 59. Architecture Decision: Logical Agent vs Physical Agent

Đây là một abstraction quan trọng.

## Logical Agent

Ví dụ:

```text
Backend Developer
QA Engineer
Architect
Reviewer
```

## Physical Agent

Ví dụ:

```text
Claude Code CLI session #123
Codex CLI session #456
Gemini CLI session #789
```

Mapping:

```text
Logical Agent
      |
      v
Agent Selection Policy
      |
      v
Physical Agent Session
```

Điều này cho phép thay thế implementation engine mà không ảnh hưởng workflow.

---

# 60. Architecture Decision: Agent Runtime as a Platform

Agent Runtime phải được coi là infrastructure layer.

Các coding agent chỉ là execution provider.

```text
             Agent Runtime
                  |
       +----------+----------+
       |          |          |
     Claude     Codex      Gemini
       |          |          |
      CLI        CLI        CLI
```

Sau này có thể thêm:

```text
OpenCode
Aider
Custom Agent
Remote Agent
Human Developer
```

Human Developer thậm chí có thể trở thành một executor trong cùng task model:

```text
Task
 |
 +--> Claude
 +--> Codex
 +--> QA Agent
 +--> Human Developer
```

---

# 61. Human as an Executor

Không phải task nào cũng phù hợp cho AI.

Platform có thể assign:

```text
TASK-010
Requires business decision
```

Executor:

```text
Human
```

Flow:

```text
Agent discovers ambiguity
       |
       v
Create Decision Request
       |
       v
Human
       |
       v
Decision Artifact
       |
       v
Agent resumes
```

Điều này giúp hệ thống thực sự hoạt động như một team hybrid.

---

# 62. Collaboration Contract

Mọi task phải có:

```text
Input
Objective
Constraints
Dependencies
Expected Output
Acceptance Criteria
Validation
Owner
Executor
```

Mọi handoff phải có:

```text
What was done
Why
What changed
Known issues
Remaining work
Artifacts
Validation result
```

Đây là contract giúp các agent khác nhau có thể phối hợp mà không cần hiểu implementation nội bộ của nhau.

---

# 63. Acceptance Criteria

Một task chỉ được coi là complete khi:

```text
Objective satisfied
AND
Dependencies satisfied
AND
Validation passed
AND
Required review passed
AND
Policy satisfied
```

Không được dùng:

```text
Agent said "done"
```

làm tiêu chí hoàn thành duy nhất.

---

# 64. Product Success Metrics

## Collaboration

- % task có handoff thành công.
- Context reuse rate.
- Agent-to-agent handoff success rate.

## Engineering

- Task success rate.
- Validation pass rate.
- Rework rate.
- Review rejection rate.
- Mean task completion time.

## Automation

- Human intervention rate.
- Auto-resolution rate.
- Autonomous task completion rate.

## Reliability

- Agent failure recovery rate.
- Workflow resume success rate.
- Workspace failure rate.

## Platform

- Number of agents integrated.
- Concurrent sessions.
- Projects managed.
- Average orchestration latency.

---

# 65. What This Product Is Not

Sản phẩm không phải:

```text
Một coding agent khác
```

Không nhằm thay thế:

```text
Claude Code
Codex
Gemini
Cursor
VS Code
```

Cũng không nhất thiết phải xây model AI riêng.

Nó là:

```text
Control Plane
+
Agent Runtime
+
Task Orchestration
+
Context Collaboration
+
Workspace Management
+
Validation
+
Human Approval
+
Git Integration
```

---

# 66. Final Product Definition

## Product

**Multi-Agent Coding Orchestration Platform**

## Input

Một tổ chức đã có nhiều coding agent độc lập:

```text
Claude Code
Codex
Gemini
Cursor
VS Code agents
Custom agents
```

Mỗi agent có thể chạy trên:

```text
IDE
CLI
Local machine
Container
Remote environment
```

## Processing

Platform:

```text
Understand Goal
    ↓
Plan
    ↓
Decompose
    ↓
Build Dependency Graph
    ↓
Select Agents
    ↓
Provision Workspaces
    ↓
Execute
    ↓
Exchange Context
    ↓
Validate
    ↓
Review
    ↓
Rework
    ↓
Merge
    ↓
Update Knowledge
```

## Output

Một hệ thống trong đó các IDE/CLI/agent hiện hữu:

```text
Claude Code
        \
Codex -----> Orchestration Platform -----> Project
        /
Gemini
        \
Cursor
```

được biến thành một **coordinated software engineering team**.

Người dùng không còn phải:

```text
Copy prompt
Copy context
Mở terminal khác
Theo dõi từng agent
Chuyển kết quả thủ công
Tự resolve dependency
Tự kiểm tra agent đã làm xong chưa
```

Thay vào đó:

```text
User
  |
  v
Goal
  |
  v
Orchestrator
  |
  +---- Architect Agent
  |
  +---- Backend Agent
  |
  +---- Frontend Agent
  |
  +---- QA Agent
  |
  +---- Reviewer Agent
  |
  +---- Human Developer
  |
  v
Completed Software
```

## Product North Star

> **Turn a collection of independent coding agents into a coordinated software engineering organization.**

Hoặc diễn đạt theo trải nghiệm người dùng:

> **“Tôi giao một mục tiêu cho project; hệ thống tự tổ chức các coding agent phù hợp, phân chia công việc, điều phối execution, chia sẻ context, kiểm tra kết quả và đưa toàn bộ team đến trạng thái hoàn thành.”**

---

# 67. Recommended Initial Architecture

Để triển khai thực tế, phiên bản đầu tiên nên tập trung vào:

```text
.NET 8 / Python
        +
PostgreSQL
        +
Redis
        +
Git Worktree
        +
Docker
        +
Claude Code Adapter
        +
Codex Adapter
        +
Generic CLI Adapter
        +
Task Orchestrator
        +
Approval Gateway
        +
GitLab/GitHub
        +
OpenTelemetry
```

Core execution loop:

```text
                    +----------------+
                    |     PROJECT    |
                    +-------+--------+
                            |
                            v
                    +---------------+
                    |    PLANNER    |
                    +-------+-------+
                            |
                            v
                    +---------------+
                    | TASK GRAPH    |
                    +-------+-------+
                            |
                            v
                    +---------------+
                    |   SCHEDULER   |
                    +-------+-------+
                            |
                            v
                    +---------------+
                    | AGENT RUNTIME |
                    +-------+-------+
                            |
             +--------------+--------------+
             |              |              |
             v              v              v
          Claude          Codex          Gemini
             |              |              |
             v              v              v
          Workspace       Workspace      Workspace
             |              |              |
             +--------------+--------------+
                            |
                            v
                    +---------------+
                    |   VALIDATOR   |
                    +-------+-------+
                            |
                    +-------+-------+
                    |               |
                    v               v
                  PASS            FAIL
                    |               |
                    v               v
                 REVIEW           REWORK
                    |
                    v
                  MERGE
                    |
                    v
              KNOWLEDGE UPDATE
```

Đây là kiến trúc nền tảng để phát triển từ một MVP điều phối agent thành một **enterprise Agent Runtime / Software Engineering Control Plane** hoàn chỉnh.
