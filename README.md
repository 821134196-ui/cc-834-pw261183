# 节点替换调度练习台

一个零前端依赖的交互式调度练习台：输入若干组节点、机架、容量和工作负载实例，先搜索安全的节点替换序列；执行过程中可临时把一台备用机标记为不可用，系统会保留已执行动作，只重排未执行动作。无法继续时，会明确指出是**可用容量、机架冗余还是实例不可驱逐时段**卡住。

## 运行

需要 Node.js ≥ 20（使用了内置 test runner 和 `structuredClone`）。

```bash
# 启动静态服务器
npm start
# 打开 http://127.0.0.1:4173
```

也可以使用任意静态服务器托管当前目录。由于页面使用 ES Module，不建议直接以 `file://` 打开 `index.html`。

```bash
npm test       # 运行 8 个引擎测试
npm run demo   # 在终端打印内置场景的计划、Pareto 前沿和扰动诊断
```

## 目录

- `js/engine.js`：纯函数调度搜索、约束检查、扰动重排和阻塞诊断，可在浏览器/Node 中复用。
- `js/examples.js`：内置节点与工作负载组。
- `js/app.js` + `index.html` + `styles.css`：原生 JS 练习台界面。
- `test/engine.test.js`：可行性、Pareto、窗口、重排保留前缀和阻塞约束测试。
- `scripts/demo.mjs`：终端演示。

## 调度模型

时间按离散槽建模。每个待替换节点设置 `"replace": true`；当前仍位于这类节点上的实例必须迁出，之后执行节点收尾/更换动作。普通节点上的固定实例不会生成无意义的自迁移动作。

每个迁移动作依次检查：

1. **实例不可驱逐时段**：迁移区间 `[start, end)` 不能与该实例的任一 `noEvict: [[a,b]]` 窗口相交；若相交，计划等到窗口结束。
2. **机架冗余**：按服务读取：
   - `minReady`：驱逐中间态至少需要多少 ready 副本；
   - `minRacks`：ready 副本至少分布在多少机架；
   - `maxPerRack`：单机架最多容纳多少该服务副本。
   
   引擎在“旧副本已摘除、新副本尚未 ready”的中间态检查一次，在“目标副本恢复”的完成态再检查一次。
3. **可用容量**：目标节点的 CPU、内存剩余量必须能容纳实例。
4. **目标可用性**：被临时停用、`status:"unavailable"`、`schedulable:false` 或本身是待替换的节点不能作为新目标。

搜索会枚举小规模练习场景中的安全序列，并用 `(完工时间, 跨机架迁移次数)` 做 Pareto 剪枝。相同状态下，若一个到达标签的当前时间不晚、跨机架次数不多，则另一个标签被支配。页面提供：

- **最快完工**：优先最小化绝对完工槽；
- **最少跨机架**：优先最小化跨机架次数；
- **均衡**：在 Pareto 前沿上做归一化折中；
- 可点击的 Pareto 代表序列。

> “跨机架迁移量”在界面中同时显示跨机架实例数和这些实例的 `volumeGb` 总和。主优化目标使用跨机架次数，GiB 作为搬运量参考。

## 扰动与重排语义

点击备用机卡片上的“临时标记不可用”后：

- `runtime.executed` 中的动作和时钟不变；
- 已更新的 `placements` 不变；
- 只重新搜索当前仍在 `replace:true` 节点上的实例和未执行的收尾动作；
- 若不存在完整序列，显示最深死路和首要约束原因，而不是给出不安全计划。

如果被停用的备用机已经接收过已执行迁移，本练习台按“停止接纳新调度”处理，不回滚已执行前缀；界面会额外提示这一语义。

## 内置练习组与预期结果

### 1. `tradeoff-bay`：多目标取舍

`ledger` 服务初始为 A 机架 1 份、B 机架 2 份，约束 `minReady=2,minRacks=2,maxPerRack=2`。A 机架上的 `ledger-a` 不能先驱逐，否则只剩 B 一个机架；必须先移动 B 上的 `ledger-b`，把冗余补到 A 或 C。

搜索得到三个 Pareto 点：

| 目标 | 完工 | 跨机架 | 代表顺序 |
|---|---:|---:|---|
| 最快完工 | 8 槽 | 3 | `ledger-b B→fix-c` → `ledger-a A→fix-b` → `cache-b` → `web-a A→fix-b` → 收尾 |
| 均衡 | 9 槽 | 2 | `ledger-b B→fix-c` → `ledger-a A→fix-b` → `cache-b` → `web-a A→sb-a` → 收尾 |
| 最少跨机架 | 12 槽 | 1 | `ledger-b B→fix-c` → `web-a A→sb-a` → `cache-b` → 等待窗口结束 → `ledger-a A→sb-a` → 收尾 |

低跨机架方案使用较慢的同机架备用机 `sb-a`（`durationFactor:2`），还要让 `ledger-a` 等待 `[4,6)` 不可驱逐窗口，因此用 4 个额外槽位避免了 2 次跨机架迁移。页面下方“同一组约束：换目标后顺序为何不同”会并排展示这两个序列。

### 2. `capacity-block`：容量约束卡住

`big-1` 需要 16 CPU，只有 `sb-heavy` 能容纳。最快计划先执行 `tiny-1 → sb-a`（0→3 槽），再执行 `big-1 → sb-heavy`。

点击“一键演练：执行 tiny-1，再停用 sb-heavy”后：

- `tiny-1` 显示为已执行且不会重排；
- 新计划不可行；
- 诊断为 **可用容量**：`big-1` 没有可容纳它的就绪目标，并列出 `sb-a`、`sb-b`、`fix-b` 的剩余 CPU/内存。

### 3. `rack-block`：机架冗余卡住

`ledger` 初始 A1/B2。正常计划为：

```text
ledger-b old-b(B) → sb-a(A)   [0,1)，跨机架
ledger-a old-a(A) → sb-a(A)   [1,2)，同机架
finalize old-a / old-b        [2,4)
```

停用 `sb-a` 后，`ledger-b` 只能留在 B；它虽然可以先安全迁到 `sb-b`，但随后驱逐 A 上的 `ledger-a` 会让服务只剩 B 一个机架，违反 `minRacks=2`。诊断为 **机架冗余**，并给出最深死路前缀 `migrate:ledger-b`。

## 两组约束对照

页面底部比较同一组节点和实例在两种约束下的顺序：

- **甲组（严格机架）**：`core` 的 `minReady=2,minRacks=2,maxPerRack=2`，初始 A1/B2，`core-a` 有窗口 `[2,5)`。
  - `core-a` 不能先动，否则跨机架数从 2 掉到 1。
  - 必须先执行 `core-b B→sb-a(A)`，0→2 槽。
  - 此时 `core-a` 的 2 槽起点落入 `[2,5)`，只能等到 5 槽，5→7 执行。
  - 结果：完工 9 槽、跨机架 1 次、等待 3 槽。
- **乙组（放宽机架）**：`minRacks=1,maxPerRack=3`。
  - `core-a` 可以先执行，`[0,2)` 与 `[2,5)` 仅边界相接、不相交，恰好避开窗口。
  - 然后执行 `core-b B→sb-b/fix-b`，无需跨机架。
  - 结果：完工 6 槽、跨机架 0 次、等待 0 槽。

因此，严格机架约束不是简单“多等一会”，而是制造了 `core-b → core-a` 的强制先后关系；这个顺序又把 `core-a` 推进不可驱逐窗口，产生 3 槽等待。放宽机架约束后，顺序反转为 `core-a → core-b`，从而同时减少完工时间和跨机架迁移。

## 自定义 JSON

左侧编辑器可载入任意场景。最小结构：

```json
{
  "id": "my-bay",
  "horizon": 16,
  "replaceSlots": 1,
  "policies": {
    "defaultMinReady": 0,
    "defaultMinRacks": 0,
    "services": {
      "api": { "minReady": 2, "minRacks": 2, "maxPerRack": 2 }
    }
  },
  "nodes": [
    { "id": "old-1", "rack": "A", "cpu": 16, "mem": 64, "replace": true },
    { "id": "sb-a", "rack": "A", "cpu": 8, "mem": 32, "role": "standby" }
  ],
  "instances": [
    { "id": "api-1", "service": "api", "node": "old-1", "cpu": 4, "mem": 8, "duration": 2, "noEvict": [[4, 6]] }
  ]
}
```

节点可设置 `durationFactor` 表示目标机重建/迁移速度差异，实例也可用 `durationOverrides: { "node-id": 3 }` 精确指定目标耗时。
