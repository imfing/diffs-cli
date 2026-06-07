# Guide（导览）设计文档

状态：草案 / Design only（暂不实现）
作者：xf78
日期：2026-06-07
技术栈：本工具已从 Go 迁移到 Rust。本文中所有后端 / 存储 / CLI 的实现参考均指 Rust 代码（`src/*.rs`，配合 clap、axum、git2、serde）。前端仍为 `web/`（React + TypeScript），相关章节不受迁移影响。

## 1. 背景与目标

当前 `diffs` 把一个 diff 平铺展示，文件顺序基本是 diff 自带的顺序。对于较大的改动，读者很难知道**从哪看起、各文件之间什么关系、为什么这么改**。

Guide 引入一种**导览式**的双栏、分步（paged）阅读体验：

- **左栏（sticky）**：渲染后的 Markdown，按作者排定的**逻辑阅读顺序**逐步讲解（"先看 A 文件建立的数据模型 → 再看 B 文件如何消费 → 最后看测试"）。顶部是**步骤翻页器 `01 / 03`**（上一步 / 下一步），一次只聚焦**当前一个 step**；其下列出该 step 关联的**文件卡片**（文件名 + 路径 + `+/-` 统计）。右栏滚动时左栏保持固定。
- **右栏**：当前 step 的 diff（按 §6 重排分组），随内容滚动；每个文件头可带一个**「Reviewed」勾选**（属 review 侧的独立关注点，见下）。
- **翻页**：点「下一步」推进到 `02 / 03 …`，左右两栏一起换成下一 step 的叙述 / 文件 / diff。未被任何 step 覆盖的文件汇入末尾的「Other changes」页。

> MVP 的锚定粒度是**变更文件**（一个 step = 若干整文件），不做 hunk / 行级锚——这让数据模型、校验与渲染都最简单（见 §2.3、§6）。

导览内容**可人工编写，也可由外部 AI / 脚本生成**。本工具本身**不内置任何 AI 集成**，只提供存储 + 只读 API + CLI 写入，"谁来生成内容"完全解耦。生成后的导览是一个 JSON 文件，可直接 commit 进仓库分享给团队。

### 设计决策（已确认）

1. **Guide 与 Review 数据零耦合**。Review = 已存在的评论系统（`.diffs/comments.json`，针对某行的讨论 / resolve）。Guide 是**另一个独立产物**：纯叙述 + diff 锚点，其数据**不引用、不感知评论**，存储互不相干。UI 上 guide 视图可以复用同一套页面 chrome（如截图里文件头的「Reviewed」勾选、右上角「Submit review」），但那些是 **review 侧的独立关注点，本文不规范**，也不写进 guide 的 JSON。**不设 `Activity / Guide / Diff` 顶部 tab**——Guide 就是它自己的视图。
2. **存储**：独立文件 `.diffs/guides/<slug>.json`，与 `comments.json` 互不相干。**slug 是仓库内全局唯一的 key**（= 文件名），不按分支分目录；某分支 / diff「有哪些导览」靠 JSON 里的 `branch` / `base` 字段过滤，而非靠路径区分。一个 diff 可有多份导览，但各自 slug 必须不同（如 `onboarding`、`onboarding-perf`）。
3. **生成方式**：不内置 AI。暴露 HTTP endpoint 与 CLI 命令用于增删改导览；外部 agent / 脚本 / 人通过它们写入。
4. **本文范围**：仅设计，不写代码。

### 非目标（本期不做）

- guide 的**数据**不与评论 / review 数据耦合（UI 可共用页面 chrome，但 review 侧的 Reviewed / Submit review 状态不在本文范围）。
- 不做 `Activity / Guide / Diff` 顶部 tab 切换。
- 不做内置 LLM 调用 / prompt 工程。
- 不做实时协同编辑。
- 分步（paged）模型下「scroll-spy 反向高亮 step」已无必要（一页一个 step）；页内「滚动高亮当前文件 / hunk」是可选增强，非 MVP 必须。

---

## 2. 核心数据模型

新增 Rust 模块 `src/guides.rs`，与现有 `src/comments.rs` 平行（仅复用其**文件读写模式**：写临时文件 + `fs::rename` 原子落盘、`std::sync::Mutex`、`git::root` / `git::discover` 定位仓库根），但两者数据互不引用。

### 2.1 磁盘布局

```
<git-root>/.diffs/
  comments.json              # 现有的 Review 评论，Guide 不碰它
  guides/              # 新增，独立；扁平目录，不按分支分子目录
    onboarding.json          # 一份导览 = 一个文件，文件名即 slug（仓库内全局唯一）
    onboarding-perf.json
```

slug 在**整个仓库内全局唯一**（扁平命名空间，不按分支分目录）。一个 diff 可以有多份导览（不同视角 / 不同作者），各自取不同 slug；某分支 / diff 关联哪些导览，由 JSON 内的 `branch` / `base` 字段在列表时过滤得出，而非由路径决定。**两个分支若都想叫 `onboarding`，必须改名**（如 `onboarding`、`onboarding-feat-x`）——slug 相同即同一文件，会相互覆盖。

### 2.2 JSON Schema

```jsonc
{
  "version": 1,
  "slug": "onboarding",
  "title": "Guide: add the guide feature",
  "branch": "feature-x",          // 可选，关联 diff 所在分支
  "base": "main",                 // 可选，关联到哪个 diff：branch-diff 的 base ref；PR 场景可存 "pr:123"
  "createdAt": "2026-06-05T00:00:00Z",
  "updatedAt": "2026-06-05T00:00:00Z",
  "steps": [
    {
      "id": "stp_a1b2c3d4e5f6g7h8",
      "title": "1. 数据模型",
      "body": "这一步在 guides.rs 新增了 File/Step 结构……（Markdown）",
      "files": ["src/guides.rs"]    // 该 step 纳入的变更文件（整文件，含其全部 hunk）；一个文件只能属于一个 step
    }
  ]
}
```

### 2.3 Rust 类型（草案）

serde 用 `rename_all = "camelCase"` 对齐 §2.2 的 JSON 字段名（与 `comments.rs` 里的 `Thread` / `Comment` 同套写法）。

```rust
// src/guides.rs
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct File {
    pub version: u32, // 固定 1
    pub slug: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub branch: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub base: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub steps: Vec<Step>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    pub id: String, // new_id("stp")
    pub title: String,
    pub body: String,        // Markdown
    pub files: Vec<String>,  // 该 step 纳入的变更文件路径（整文件）；一个文件只能属于一个 step
}
```

> MVP 锚定粒度是**变更文件**：一个 step 关联若干文件路径，右栏整文件渲染其全部 hunk。更细的 hunk / 行级锚是后续增强（见 §10）。

### 2.4 关键设计取舍

- **完全独立于 Review/评论**：Guide 数据结构里没有任何指向 `comments.json` 的字段。两个系统可以并存于 `.diffs/` 下，但互不读写、互不感知。
- **文件路径即锚**：MVP 用变更文件的 `path` 作锚，前端 `splitPatchByFile` 已能按路径切出每个文件的完整 patch，定位零额外解析；路径比行号 / hunk 起始行更稳，diff 内容变动也不易失效。
- **整份导览即一个可分享文件**：commit 进仓库或单独发给队友，对方用 `diffs` 打开同一 diff 即可看到导览，零额外基础设施。
- **不持久化仓库绝对路径**：导览文件存于 `<repo>/.diffs/guides/<slug>.json`，仓库根天然由文件位置隐含，运行时用 `git::root` 定位即可。故 JSON 里**不存** `repo` 绝对路径——它对每台机器不同，写进可 commit / 分享的产物只会泄漏本机状态、降低可移植性。需要仓库标识时用相对元数据（如 remote URL）另议。
- **精简 schema，署名后置**：MVP 只保留阅读模型必需的字段——`version` / `slug` / `title` / `steps` / 时间戳，加可选的 `branch` / `base`。`summary`（顶层总览）、`author`、`generatedBy`（来源标注：人 / 模型 / 脚本）都是 nice-to-have 元数据，不影响渲染，等需要时再加（serde `#[serde(default)]` 可平滑兼容旧文件）。

---

## 3. 存储层（`src/guides.rs`）

仿照 `src/comments.rs` 的 `Store` 读写模式（`Mutex<()>` 串行化、写临时文件 + `fs::rename` 原子落盘、`new_id(prefix)` 生成 id、`CommentError` 风格的错误枚举）：

```rust
pub struct Store {
    root: PathBuf,
    dir: PathBuf, // <root>/.diffs/guides
    lock: Mutex<()>,
}

impl Store {
    pub fn new(cwd: impl AsRef<Path>) -> Result<Self>; // 用 git::root 定位
    pub fn list(&self) -> Result<Vec<Summary>>;        // 扫描 guides/*.json，返回轻量摘要
    pub fn get(&self, slug: &str) -> Result<File>;
    pub fn create(&self, input: CreateInput) -> Result<File>; // 空（无 step）或带 steps（--from-json 导入）
    pub fn delete(&self, slug: &str) -> Result<()>;
    pub fn add_step(&self, slug: &str, input: AddStepInput) -> Result<File>;    // 认领文件成新 step
    pub fn update_step(&self, slug: &str, step_id: &str, input: UpdateStepInput) -> Result<File>;
    pub fn remove_step(&self, slug: &str, step_id: &str) -> Result<File>;       // 文件退回未标注区
}
```

> **写入只走 CLI**：store 提供整份创建（`create`，空或从 JSON 导入）与 step 级增删改（`add_step` / `update_step` / `remove_step`），都经 CLI 暴露（§5）。step 顺序即认领顺序，MVP 不设 reorder（要调序重导入 `--from-json`）。**HTTP 侧暂不开放任何写端点**（§4 只读）——浏览器只消费导览，写入路径收敛到命令行，等应用内编辑落地再考虑加 HTTP 写面。

要点：
- 生成 step id 用 `new_id("stp")`（`comments.rs` 已有该 helper，可抽到共享模块或各自保留一份）。
- 每次写操作更新 `updated_at`，在 `lock` 临界区内 `load → 修改 → save` 原子落盘（与 `comments.rs` 的 `save` 同套：写 `<dir>/.guide-<id>.json` 临时文件再 `fs::rename`）。
- `slug` 校验为安全文件名（`^[a-z0-9][a-z0-9-]*$`），避免路径穿越；slug 即文件名，**仓库内全局唯一**。
- **slug 冲突（重要）**：`create` 命中已存在的 slug 时**报错拒绝**（不静默覆盖他人 / 其他分支的同名导览）；需要覆盖须显式（如 `--force` 或先 `delete`）。`list` 不靠目录区分分支，而是读每份 JSON 的 `branch` / `base` 字段后过滤（见 §4）。
- **watcher 忽略（Rust 特有）**：`.diffs/` 是被 git 跟踪的目录，文件监听器靠 `server.rs::is_structurally_ignored` 跳过评论的 `.comments-*.json` 临时文件以免触发 reload 死循环。Guide 的临时文件（及 `guides/*.json` 自身的写入）必须同样被该忽略规则覆盖，否则每次写导览都会让浏览器误刷新。落地时应把这套临时文件命名/忽略规则收敛到一处共享（呼应现有评审里对 `.comments-*` 硬编码的整改建议）。
- **文件校验（重要）**：每个写操作（`create` / `add_step` / `update_step`）落盘前，对受影响 step 的 `files[]` 路径校验：每个路径是否存在于当前 diff，以及**该导览内每个文件只归一个 step**（一个文件不能被两个 step 同时占用，见 §6.5）。校验失败应报错拒绝。这需要当前 diff 的变更文件清单（见 §6）。

---

## 4. HTTP API（`src/server.rs`）

在 `src/server.rs` 的 axum `Router` 上与现有 `/api/comments` 同风格新增路由（独立 handler，不复用评论 handler）；store 像 `comments` 那样放进 `AppState`（`Option<Arc<guides::Store>>`），无 git 仓库时返回 503。

**MVP HTTP 面是只读的**——前端只消费导览，写入走 CLI（§5）：

| 方法 & 路径 | 作用 | 请求体 |
| --- | --- | --- |
| `GET /api/guides` | 列出导览摘要，默认按当前分支过滤（读各 JSON 的 `branch` 字段，非按目录）；`?all=1` 列全部 | — |
| `GET /api/guides/{slug}` | 获取某份完整导览 | — |

> **HTTP 写端点全部延后**：`POST/DELETE /api/guides`、`POST/PATCH/DELETE .../steps` 等都等到**应用内编辑真正落地**再加。MVP 阶段写入（含 step 级增删改）一律走 CLI（§5），浏览器侧只读，无需任何 HTTP 写面。

---

## 5. CLI（`src/cli.rs`）

仿照 `src/cli.rs` 中 `CommentSubcommand` 的 clap（derive）子命令结构，新增 `Command::Guide(GuideArgs)` + `GuideSubcommand`，并把 step 操作收进嵌套的 `guide steps <...>`（`GuideStepsSubcommand`）。CLI 是 MVP 的**唯一写入路径**（HTTP 只读，见 §4）。

核心模型：**`create` 先把整份导览建出来，此时没有任何 step，于是当前 diff 的所有变更文件都落在末尾的「未标注区」（§6.6 的 Other changes）；`steps add` 再把文件从该区认领进具名 step。** 一个文件要么属于某个 step，要么还在未标注区——**未标注区不需要单独持久化**：它是「当前 diff 全部变更文件 − 已被 step 认领的文件」算出来的（§6.6），JSON 里只存 `steps[].files`。（注意：这与"认领时校验文件确实在 diff 里"是两回事——后者仍要做，见 §5 设计要点与 §6.8。）

```
diffs guide list                                          # 当前分支的导览摘要
diffs guide show   [--slug <slug>] [--json]
diffs guide create [--slug <slug>] [--from-json -]        # 不带 --from-json：建空导览（全部文件待认领）
diffs guide delete [--slug <slug>]

diffs guide steps add <file>... --title <t> --content -   [--slug <slug>]  # 认领若干文件，自动生成 step id
diffs guide steps list                                    [--slug <slug>]  # 列 step id / title / 已认领文件
diffs guide steps update <id> [<file>...] [--title <t>] [--content -]  [--slug <slug>]
diffs guide steps remove <id>                             [--slug <slug>]
```

设计要点：
- **`--slug` 可省略**：省略时默认操作**当前分支的那份导览**；该分支有 0 份或多份时报错并要求显式 `--slug`。`create` 省略 slug 时按分支名生成默认 slug（`feat/x` → `feat-x`，做文件名安全化）。
- **`create` 两条路**：
  - 不带 `--from-json` → 写一份**无 step** 的导览（仅元数据），所有 diff 文件自动进未标注区，等 `steps add` 认领。
  - `--from-json -` → 从 stdin 一次性导入整份导览（含全部 steps），给外部生成器最顺手：
    ```bash
    my-llm-script | diffs guide create --slug onboarding --from-json -
    ```
- **`steps add <file>...`**：位置参数是要认领的变更文件；命令自动生成 `stp_…` id 并回显。`--title` 必填；`--content` 是 step 正文（写入 schema 的 `body` 字段），复用现有 `body_from_flag` 模式，`--content -` 读 stdin（长 Markdown 关键）。
- **`steps update <id>`**：给出位置文件则**替换**该 step 的文件集；`--title` / `--content` 仅在传入时更新。
- **`steps remove <id>`**：删除该 step，其文件**退回未标注区**。
- **认领约束**：`steps add` / `update` 时，若某文件已属另一个 step → 报错（一个文件只能属于一个 step，§6.5）；若某文件不在当前 diff 的变更清单里 → 报错（store 经 `git.rs` 取变更文件清单校验，见 §6.8）。
- **step 顺序 = 认领顺序**（或 `--from-json` 的数组序），即翻页器页序；MVP 不提供 reorder 命令，需要调序可重导入 `--from-json`（专门的 reorder 列为后续）。
- 入口仿 `run_comments`：`let store = guides::Store::new(dir)?;` 后 `match` 子命令。

---

## 6. 文件分组与覆盖（核心算法 · Model B 重排分组）

右栏采用**重排分组模型**：diff 不再按 patch 自带的文件顺序展示，而是按 Guide 的 `steps[]` 顺序，把每个 step 关联的**变更文件**抽出来分组到该 step 下；未被任何 step 覆盖的文件落入结尾的「Other changes」桶。

### 6.1 文件身份

`splitPatchByFile(patch)`（`web/src/components/diff-view/helpers.ts` 已有）把整份 patch 按文件切成 `{ path, filePatch }[]`，`filePatch` 是该文件完整的 unified diff（其全部 hunk、两侧改动）。**文件 key = `path`**：路径天然稳定，不随 diff 内容变动漂移。

### 6.2 Step → 文件映射

一个 step 的 `files[]` 就是它纳入的变更文件路径集合，可跨多个文件。每个路径直接对应 `splitPatchByFile` 切出的一段 `filePatch`，整段（全部 hunk）归该 step 渲染。截图左栏「一个 step 列出若干文件卡片」= 该 step `files[]` 的逐文件呈现（文件名 / 路径 / `+-` 统计）。

### 6.3 顺序

存在两种顺序，Model B 下**以 Guide 顺序为准**：
- **自然顺序**：patch 自带的文件顺序（`fileIndex`），diff 的客观物理序。
- **Guide 顺序**：`steps[]` 数组顺序，即右栏分组的渲染顺序。
- **step 内多文件的排序**：按该 step `files[]` 的书写顺序（作者意图）。
- 「Other changes」桶内：按自然顺序。

### 6.4 一个 step 关联多个文件

- `files` 本就是数组，天然支持多个文件。
- step 页按 `files[]` 顺序逐文件渲染，各文件保留自己的文件头；右栏正常滚动即可在多文件间浏览。
- MVP **不做** step 内的「primary file / 默认滚动目标」与 `1/3 ‹ ›` 子导航——一页只渲染当前 step，普通滚动已够用；真有大 step 的导航需求再议。

### 6.5 文件归属唯一（硬约束）

**一个变更文件只能属于一个 step。** 重排模型下同一文件出现在多个 step 会造成内容重复、阅读困惑，故本期定为**硬约束**：
- 写操作（`create` / `add_step` / `update_step`）落盘时校验：若某 `files[]` 路径已被另一个 step 占用，**直接报错拒绝**（而非降级 / 警告），错误信息点明冲突路径与占用它的 step。
- 由此「covered」集合天然无重叠，§6.6 的 uncovered 计算退化为一次简单的集合差。

### 6.6 未覆盖的文件

- 计算 `covered = ⋃ step 的 files`（各 step 互不重叠，见 §6.5），`uncovered = 全部变更文件 − covered`，按路径做集合差。
- **核心原则：永远不静默隐藏 diff 内容**（隐藏改动破坏评审信任）。`uncovered` 全部进入结尾合成的伪 step「Other changes (N files)」，按自然顺序排列，默认可折叠 + 数量角标。
- 给作者**覆盖率提示**（"12 个文件中 9 个已纳入导览"），便于人 / AI 补全。

### 6.7 渲染所需：按 step 重组子 patch

`splitPatchByFile` 已给出每个文件完整的 `filePatch`。按 step 渲染只需：把该 step `files[]` 对应的 `filePatch` 按 6.3 顺序拼接成一段合法 unified patch，交给 `parsePatchFiles` 解析后用一个 `<CodeView>` 渲染。即"每个 step 组 = 该 step 选中文件的 patch 拼接"，无需 hunk 级切分。

### 6.8 文件校验

- **校验内容**：`files[]` 的每个路径必须存在于当前 diff 的变更文件清单中，且未被其他 step 占用（§6.5）。
- **校验位置（后端）**：因为写入走 CLI（§5），`add_step` / `update_step` / `create` 落盘前就在 Rust 侧校验文件成员关系——`git.rs` 能产出当前 diff 的变更文件清单。取清单时**不要只认 `+++ b/<path>`**：删除文件那侧是 `+++ /dev/null`，重命名 / mode-only 改动也未必有可靠的 `+++` 行。应按 `diff --git a/<old> b/<new>` 文件头（必要时配合 `rename from/to`、`--- a/<path>`）切分取路径，与前端 `splitPatchByFile` 的切分口径一致；或直接走 git2 的 diff 回调按 delta 拿 `old_file` / `new_file`。
- 前端 `splitPatchByFile` 的 `path` 集合同样可在渲染时核对，给出 stale 文件的视觉提示。

---

## 7. 前端（`web/`）

### 7.1 新增能力：Markdown 渲染

当前项目**完全没有 Markdown 渲染**（评论是 `whitespace-pre-wrap` 纯文本）。MVP 先引入**裸 `react-markdown`** 即可：
- 它**默认转义原始 HTML**（不启用 `rehype-raw` 就不会渲染外部生成器塞进来的 `<script>` 等），所以 MVP **不需要 `rehype-sanitize`**——没有 raw HTML 通道，就没有要净化的东西。
- `remark-gfm`（表格 / 任务列表 / 删除线）与 `rehype-sanitize`（仅当将来开 raw HTML 时才需要）**按需再加**，不在第一版默认依赖里。

### 7.2 组件拆分

第一版只要**三块**，翻页器 / 叙述 / Other changes 先内联在 `GuideView` 里，等真有复用或体量压力再抽出：

```
web/src/components/guide/
  GuideView.tsx       # 顶层：sticky 左栏（翻页器 + 叙述 + 文件卡片）+ 可滚动右栏；持有「当前 step」状态。翻页器 / 叙述 / Other changes 页先内联于此
  Markdown.tsx        # 封装裸 react-markdown + 主题（GFM / sanitize 按需再加，见 §7.1）
  buildGuideGroups.ts # 核心：patch → 按 step 分组的子 patch（实现 §6 算法）
```

> 后续按需抽出 `StepPager`（`01 / 03` 翻页器）、`GuideNarrative`（叙述 + 文件卡片）、`StepDiffGroup`（右栏 diff）、`OtherChanges`（末页）——它们都是 `GuideView` 内的局部 JSX，拆分是纯重构，不改数据流。

- **独立视图，不是 tab**：Guide 沿用路由 `/guide/:slug`（react-router v7 已在用），**没有** `Activity / Guide / Diff` 顶部切换。
- **分步（paged）渲染**：一次只渲染**当前 step**——`buildGuideGroups.ts` 按 §6 预先把 patch 按 step 分成各自的子 patch（选中文件的 `filePatch` 拼接），`GuideView` 据当前页选其一：左栏（sticky）显示翻页器 + 该 step 的叙述 + 文件卡片，右栏渲染该 step 的子 patch（一个 `<CodeView>`）。`uncovered` 汇成末尾一页。
- **左右关系**：左栏固定、右栏滚动；翻页时两栏一起换内容。因为一次只挂**一个** step 的 `<CodeView>`，原 Model B「纵向堆叠多个 CodeView」的**多实例性能问题自然消解**（无需虚拟化）。
- **Reviewed 勾选（独立关注点）**：右栏文件头的「Reviewed」是 review 侧的逐文件进度，与 guide 数据无关；若接入，它读写 review 那套状态，不进 guide JSON（见 §1 决策 1）。
- 数据获取走现有 `apiFetch`（`web/src/lib/api.ts`）。

---

## 8. 导出 / 分享

**MVP 只靠 JSON**：导览文件本身即可分享 —— commit 进仓库，或单独发文件。对方 `diffs` 打开同一 diff + 选择该 slug 即可重现导览，零额外基础设施。

> **未来想法（不在实现路径）**：自包含 HTML 导出（扩展 `web/src/lib/exportHtml.ts` 的「guide 模式」，复用其内联字体 / shadow DOM 方案，发给没装工具的人）。它会在导览阅读模型尚未验证前先把渲染面翻倍，故**先不做**，等核心阅读体验站稳再议。

---

## 9. 增量实现路径（建议顺序）

| 阶段 | 内容 | 产出 |
| --- | --- | --- |
| M1 | `src/guides.rs` 存储层（list/get/create/delete + add/update/remove_step，含文件成员校验）+ 单测（仿 `comments.rs`，含 watcher 忽略规则） | 能读写 `.diffs/guides/*.json` |
| M2 | 只读 HTTP API（`src/server.rs`：`GET /api/guides`、`GET /api/guides/{slug}`） | 前端可消费导览 |
| M3 | CLI `diffs guide list/show/create/delete` + `guide steps add/list/update/remove`（`src/cli.rs`，`create --from-json -`） | 外部生成器一键写入 + step 级编辑 |
| M4 | 前端三块（`GuideView` + `Markdown` + `buildGuideGroups`，§6 重排算法）：sticky 左栏内联翻页器 / 叙述 / Other changes，右栏当前 step 一个 CodeView | 用手填 JSON 即可体验完整分步重排阅读流 |

> M1–M4 即可交付一个可用的只读导览（外部生成 + 工具内阅读），是最小有价值闭环。

---

## 10. 待定问题（Open Questions）

1. 后端文件校验（`add_step` 等写入时按 `diff --git` 文件头 / git2 delta 取变更清单，含删除 / 重命名，见 §6.8）的实现细节：清单缓存粒度、与 `/api/*-diff` 现有解析的复用程度。
2. 一个 diff 多份导览时，UI 如何切换 / 默认展示哪份？
3. `base` 字段如何稳定标识一个 diff（本地 `git diff HEAD` vs `branch-diff?base=` vs PR）？需与现有 `/api/local-diff`、`/api/branch-diff`、`/api/patch/...` 的标识方式对齐。
4. step body 的 Markdown 何时需要开 raw HTML / 图片 / 外链？届时才引入 `rehype-raw` + `rehype-sanitize` 并明确净化策略（MVP 裸 `react-markdown` 默认转义 HTML，见 §7.1）。
5. 分步（paged）渲染下一次只挂当前 step 的 `<CodeView>`，多实例性能问题已基本消解；待定的是**翻页体验**：切页是否要预取相邻 step 的子 patch、是否保留各页滚动位置、单个超大 step（很多文件）是否仍需页内懒渲染。
6. **后续增强**：是否要把锚定粒度从「整文件」细化到 hunk / 行级（当前 MVP 只做文件级，见 §2.3、§6）？届时 `files[]` 需扩展为带 side / 行范围的 anchor，归属唯一约束随之降到 hunk 粒度。
