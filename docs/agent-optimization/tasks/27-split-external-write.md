# 任务 27：工作区外的「读」和「写」共用一个权限名，授权读等于顺手授权写

工作树根目录：`/home/xixi/Git/OmniStudio/.claude/worktrees/agent-optimize`

## 允许改动的文件（只有这两个）

1. `apps/studio/src/bun/permissions.ts` —— 源码
2. `apps/studio/src/bun/permissions.test.ts` —— 既有测试文件，**只许加用例**；若有既有用例与新语义冲突，**不要硬改**，在汇报第 6 节写清是哪条、冲突在哪、建议怎么改，等我放行

别的文件一个都不许碰。

## 现状

`apps/studio/src/bun/permissions.ts` 里，工作区外的操作全部翻译成**同一个权限名** `external_directory`：

**读类**（第 622 到 645 行，`read_file` / `view_image` / `list_dir` / `glob` / `grep`）：

```
639        return {
640          permission: "external_directory",
641          pattern: target,
642          title: "读取工作区之外的文件",
643          detail: { 路径: target },
644          always: [path.dirname(target), path.dirname(target) + "/*"],
645        };
```

**写类**（第 587 到 597 行，`write_file` / `edit_file`）：

```
593          permission: "external_directory",
594          pattern: path.dirname(target),
595          title: "在工作区之外写文件",
597          always: [path.dirname(target), path.dirname(target) + "/*"],
```

**补丁类**（第 571 到 575 行，`apply_patch`）也是 `external_directory`。

另外第 663、690 行（参考图 / 首帧读取）同样用它。

## 缺陷

授权规则的匹配只看「权限名 + 路径模式」。读和写共用 `external_directory`，于是：

用户为了让模型**读**一个工作区外的文件，点了「总是允许」→ 落下一条 `external_directory` + 该父目录的规则 → **之后模型往那个目录里写文件、改文件、打补丁，一次都不会再问**。

弹窗当时说的是「读取工作区之外的文件」，用户以为自己批的是读。实际批出去的是那个目录的读**加**写。

第 247 到 248 行的注释写着「工作区外的读写默认都要问一句：这是 agent 最容易被注入利用的边界」——默认档确实都问了，但**一旦用户批过一次读，写就跟着免问了**，这道边界就漏了。

## 期望语义

**给写类操作换一个独立的权限名 `external_write`，读类保持 `external_directory` 不变。**

这样：

- 用户已经存下的 `external_directory` 规则继续只放行读——**老规则不会失效，读的体验完全不变**；
- 写类操作第一次发生时会单独问一次，与读的授权互不代替。

具体改动：

1. **写类三处换权限名**：
   - 第 571 行附近（`apply_patch` 工作区外那支）
   - 第 593 行附近（`write_file` / `edit_file`）
   把 `permission: "external_directory"` 改成 `permission: "external_write"`。
   `pattern`、`title`、`detail`、`always` 全部保持原样不动。

2. **读类五处不动**：`read_file` / `view_image` / `list_dir` / `glob` / `grep`（第 622 到 645 行）、第 663 行、第 690 行、第 608 到 620 行的 `request_permissions`，一律保持 `external_directory`。

3. **默认规则补一条**：第 247 到 248 行那个默认清单里，`external_directory` 那条下面照样式加一条 `external_write`，`pattern: "*"`，`action: "ask"`，注释说明写比读更危险、默认也要问。

4. **另外三个档位跟着补**：
   - 第 268 行附近（`auto` 档）：`external_directory` 是 `allow`，`external_write` 也加一条 `allow`（auto 档的语义就是全放行，不要在这里偷偷收紧）。
   - 第 280 行附近（`manual` 档）：照该档对 `external_directory` 的处理同样加一条。
   - 第 287 行附近（`strict` 档）：`external_directory` 是 `deny`，`external_write` 也加 `deny`。

5. **中文标签**：第 739 行的 `HUMAN_PERMISSION_LABELS` 加一项 `external_write: "写入工作区之外"`（`external_directory` 的文案改成 `"读取工作区之外"` 更准确，一并改）。

6. **权限名探针**：第 800 到 808 行的 `PROBES` 数组加一条 `{ permission: "external_write", pattern: "*" }`，否则权限摘要里看不到这一项。

7. 第 39 行那句列举权限名的注释，把 `external_write` 补进去。

## 不要做的事

- 不要改 `always` 的范围（「读一个文件却授权整个父目录」是另一件事，这次不碰）
- 不要改任何 `pattern` / `title` / `detail`
- 不要动规则匹配逻辑本身
- 不要动 `isSpillPath` 那个口子
- 不要动沙箱相关的 `sandbox_escalation`

## 测试要求

往 `apps/studio/src/bun/permissions.test.ts` 加用例。至少覆盖这 5 条：

1. **写工作区外的文件 → 权限名是 `external_write`**（`write_file` 与 `edit_file` 各断言一次）。
2. **工作区外的 `apply_patch` → 权限名是 `external_write`**。
3. **读工作区外的文件 → 权限名仍是 `external_directory`**（`read_file` 断言一次，另挑 `glob` 或 `grep` 再断言一次）。
4. **一条已存的 `external_directory` 允许规则，不放行写**（**这条就是本次要修的缺陷，改之前会被放行**）：造一条 `external_directory` + 某父目录 + `allow` 的规则，然后对同一目录下的 `write_file` 求裁决，断言结果不是 allow。
5. **四个档位各自都有 `external_write` 的默认条目**：断言 default / auto / manual / strict 四份规则里都能找到 `external_write`，且动作与该档 `external_directory` 的动作一致。

第 4 条要用这个文件里既有的「求裁决」写法（自己看现有用例是怎么调的，照抄）。

## 验收标准（汇报第 5 节逐条填）

- [ ] 写类三处（apply_patch、write_file、edit_file）换成 `external_write`
- [ ] 读类各处仍是 `external_directory`，一处没动
- [ ] 四个档位都补了 `external_write` 默认条目，动作与同档 `external_directory` 一致
- [ ] 中文标签、PROBES、第 39 行注释都补了
- [ ] `always` / `pattern` / `title` / `detail` / 匹配逻辑 / `isSpillPath` 一律未动
- [ ] 既有用例全绿；若有冲突，照实报出、不硬改
- [ ] 把 `permissions.ts` 的改动还原后，第 4 条用例会变红（你自己先试一遍）
- [ ] 源码改动不超过 30 行

## 门命令

```
bash docs/agent-optimization/gate.sh docs/agent-optimization/manifests/27-split-external-write.json
```

输出原样贴进汇报第 4 节。
