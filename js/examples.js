// 内置练习组。所有数据都是普通 JSON 可序列化对象，也可从页面 JSON 编辑器替换。

export const tradeoffScenario = {
  id: 'tradeoff-bay',
  title: '多目标取舍：机架顺序、不可驱逐窗口与跨机架',
  description:
    'ledger 是三副本服务，初始为 A 机架 1 份、B 机架 2 份。A 机架副本不能先驱逐；B 机架副本必须先补到 A 或 C。A 机架老旧备用机 sb-a 同机架但重建慢，sb-c 更快却可能产生跨机架迁移。',
  horizon: 18,
  replaceSlots: 1,
  policies: {
    defaultMinReady: 0,
    defaultMinRacks: 0,
    services: {
      ledger: { minReady: 2, minRacks: 2, maxPerRack: 2 },
    },
  },
  nodes: [
    { id: 'old-a', rack: 'A', cpu: 16, mem: 64, role: 'source', replace: true },
    { id: 'old-b', rack: 'B', cpu: 16, mem: 64, role: 'source', replace: true },
    { id: 'fix-b', rack: 'B', cpu: 32, mem: 128, role: 'general' },
    { id: 'fix-c', rack: 'C', cpu: 32, mem: 128, role: 'general' },
    { id: 'sb-a', rack: 'A', cpu: 8, mem: 32, role: 'standby', durationFactor: 2, note: '同机架、容量较小且重建慢' },
    { id: 'sb-b', rack: 'B', cpu: 16, mem: 64, role: 'standby' },
    { id: 'sb-c', rack: 'C', cpu: 16, mem: 64, role: 'standby', note: '高带宽备用机，但从 A/B 迁入会跨机架' },
  ],
  instances: [
    { id: 'ledger-a', service: 'ledger', node: 'old-a', cpu: 4, mem: 8, duration: 2, volumeGb: 120, noEvict: [[4, 6]] },
    { id: 'ledger-fixed', service: 'ledger', node: 'fix-b', cpu: 4, mem: 8, duration: 2, volumeGb: 120, noEvict: [] },
    { id: 'ledger-b', service: 'ledger', node: 'old-b', cpu: 4, mem: 8, duration: 2, volumeGb: 120, noEvict: [] },
    { id: 'web-a', service: 'web', node: 'old-a', cpu: 4, mem: 8, duration: 1, volumeGb: 20, noEvict: [] },
    { id: 'cache-b', service: 'cache', node: 'old-b', cpu: 4, mem: 8, duration: 1, volumeGb: 40, noEvict: [] },
  ],
};

export const capacityBlockScenario = {
  id: 'capacity-block',
  title: '扰动演练：停用唯一大容量备用机',
  description:
    'big-1 需要 16 CPU；只有 sb-heavy 能容纳它。可先执行 tiny-1，再把 sb-heavy 标记为不可用，观察计划只保留已执行动作并在容量约束处报阻。',
  horizon: 12,
  replaceSlots: 1,
  policies: { defaultMinReady: 0, defaultMinRacks: 0, services: {} },
  nodes: [
    { id: 'old-big', rack: 'A', cpu: 32, mem: 128, role: 'source', replace: true },
    { id: 'sb-a', rack: 'A', cpu: 4, mem: 16, role: 'standby' },
    { id: 'sb-b', rack: 'B', cpu: 4, mem: 16, role: 'standby' },
    { id: 'sb-heavy', rack: 'C', cpu: 32, mem: 128, role: 'standby', note: '唯一能接收 big-1 的备用机' },
    { id: 'fix-b', rack: 'B', cpu: 8, mem: 32, role: 'general' },
  ],
  instances: [
    { id: 'tiny-1', service: 'tiny', node: 'old-big', cpu: 2, mem: 4, duration: 3, volumeGb: 5, noEvict: [] },
    { id: 'big-1', service: 'big', node: 'old-big', cpu: 16, mem: 32, duration: 2, volumeGb: 500, noEvict: [[1, 3]] },
  ],
};

export const rackBlockScenario = {
  id: 'rack-block',
  title: '扰动演练：停用 A 机架备用机导致机架冗余卡死',
  description:
    'ledger 初始为 A1/B2，minRacks=2。必须先把 ledger-b 迁到 A 机架，随后 ledger-a 才能离开 A。若 sb-a 被停用，ledger-b 只能留在 B；之后驱逐 ledger-a 会使服务只剩 B 一个机架。',
  horizon: 12,
  replaceSlots: 1,
  policies: {
    defaultMinReady: 0,
    defaultMinRacks: 0,
    services: { ledger: { minReady: 2, minRacks: 2, maxPerRack: 2 } },
  },
  nodes: [
    { id: 'old-a', rack: 'A', cpu: 16, mem: 64, role: 'source', replace: true },
    { id: 'old-b', rack: 'B', cpu: 16, mem: 64, role: 'source', replace: true },
    { id: 'fix-b', rack: 'B', cpu: 32, mem: 128, role: 'general' },
    { id: 'sb-a', rack: 'A', cpu: 8, mem: 32, role: 'standby', note: '唯一能把冗余副本补回 A 的目标' },
    { id: 'sb-b', rack: 'B', cpu: 16, mem: 64, role: 'standby' },
  ],
  instances: [
    { id: 'ledger-a', service: 'ledger', node: 'old-a', cpu: 4, mem: 8, duration: 1, volumeGb: 80, noEvict: [] },
    { id: 'ledger-b', service: 'ledger', node: 'old-b', cpu: 4, mem: 8, duration: 1, volumeGb: 80, noEvict: [] },
    { id: 'ledger-fixed', service: 'ledger', node: 'fix-b', cpu: 4, mem: 8, duration: 1, volumeGb: 80, noEvict: [] },
  ],
};

const comparisonBase = {
  id: 'constraint-comparison-base',
  title: '两组约束对照',
  horizon: 12,
  replaceSlots: 1,
  nodes: [
    { id: 'old-a', rack: 'A', cpu: 16, mem: 64, role: 'source', replace: true },
    { id: 'old-b', rack: 'B', cpu: 16, mem: 64, role: 'source', replace: true },
    { id: 'fix-b', rack: 'B', cpu: 32, mem: 128, role: 'general' },
    { id: 'sb-a', rack: 'A', cpu: 8, mem: 32, role: 'standby' },
    { id: 'sb-b', rack: 'B', cpu: 16, mem: 64, role: 'standby' },
    { id: 'sb-c', rack: 'C', cpu: 16, mem: 64, role: 'standby' },
  ],
  instances: [
    { id: 'core-a', service: 'core', node: 'old-a', cpu: 4, mem: 8, duration: 2, volumeGb: 100, noEvict: [[2, 5]] },
    { id: 'core-b', service: 'core', node: 'old-b', cpu: 4, mem: 8, duration: 2, volumeGb: 100, noEvict: [] },
    { id: 'core-fixed', service: 'core', node: 'fix-b', cpu: 4, mem: 8, duration: 2, volumeGb: 100, noEvict: [] },
  ],
};

export const strictComparisonScenario = {
  ...comparisonBase,
  id: 'compare-strict',
  title: '甲组：minRacks=2，A1/B2，窗口 [2,5)',
  description: '机架冗余要求始终至少跨 2 个机架。A 机架只有 core-a，因此它不能先被驱逐；必须先移动 B 机架上的 core-b。',
  policies: {
    defaultMinReady: 0,
    defaultMinRacks: 0,
    services: { core: { minReady: 2, minRacks: 2, maxPerRack: 2 } },
  },
};

export const relaxedComparisonScenario = {
  ...comparisonBase,
  id: 'compare-relaxed',
  title: '乙组：minRacks=1，同一窗口 [2,5)',
  description: '机架跨数约束放宽后，core-a 可以先驱逐；0→2 槽执行恰好避开 [2,5) 不可驱逐窗口，随后再处理 core-b。',
  policies: {
    defaultMinReady: 0,
    defaultMinRacks: 0,
    services: { core: { minReady: 2, minRacks: 1, maxPerRack: 3 } },
  },
};

export const presets = [
  tradeoffScenario,
  capacityBlockScenario,
  rackBlockScenario,
  strictComparisonScenario,
  relaxedComparisonScenario,
];

export const presetMap = Object.fromEntries(presets.map((s) => [s.id, s]));
