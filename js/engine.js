// 纯函数调度引擎：无第三方依赖，可同时在浏览器和 Node 中运行。
// 时间为离散槽；计划是“迁移动作 + 收尾更换动作”的顺序序列。

export const DEFAULT_HORIZON = 24;

const INF = Number.POSITIVE_INFINITY;

function clone(value) {
  return structuredClone(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonicalJson(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(canonicalJson(value));
}

export function normalizeScenario(input = {}) {
  const s = clone(input);
  s.schemaVersion = s.schemaVersion ?? 1;
  s.id = s.id ?? 'untitled';
  s.title = s.title ?? '未命名练习组';
  s.description = s.description ?? '';
  s.horizon = Number.isFinite(s.horizon) ? s.horizon : DEFAULT_HORIZON;
  s.timeUnit = s.timeUnit ?? '槽';
  s.replaceSlots = s.replaceSlots ?? 1;
  s.nodes = Array.isArray(s.nodes) ? s.nodes : [];
  s.instances = Array.isArray(s.instances) ? s.instances : [];
  s.policies = s.policies ?? {};
  s.policies.services = s.policies.services ?? {};
  // 默认不额外要求冗余；有状态服务在 policies.services 中显式给出 PDB/机架约束。
  s.policies.defaultMinReady = s.policies.defaultMinReady ?? 0;
  s.policies.defaultMinRacks = s.policies.defaultMinRacks ?? 0;
  s.policies.defaultMaxPerRack = s.policies.defaultMaxPerRack ?? INF;

  for (const n of s.nodes) {
    n.cpu = n.cpu ?? 0;
    n.mem = n.mem ?? 0;
    n.role = n.role ?? 'general';
    n.status = n.status ?? 'ready';
    n.replace = n.replace ?? n.role === 'source';
  }
  for (const i of s.instances) {
    i.cpu = i.cpu ?? 1;
    i.mem = i.mem ?? 1;
    i.duration = i.duration ?? 1;
    i.service = i.service ?? 'default';
    i.noEvict = Array.isArray(i.noEvict) ? i.noEvict : [];
    i.volumeGb = i.volumeGb ?? 0;
  }
  return s;
}

export function validateScenario(input) {
  const s = normalizeScenario(input);
  const errors = [];
  const nodeIds = new Set();
  for (const [idx, n] of s.nodes.entries()) {
    if (!n.id) errors.push(`nodes[${idx}] 缺少 id`);
    if (nodeIds.has(n.id)) errors.push(`节点 id 重复：${n.id}`);
    nodeIds.add(n.id);
    if (!n.rack) errors.push(`节点 ${n.id ?? idx} 缺少 rack`);
    if (!(n.cpu >= 0)) errors.push(`节点 ${n.id} 的 cpu 必须是非负数`);
    if (!(n.mem >= 0)) errors.push(`节点 ${n.id} 的 mem 必须是非负数`);
  }

  const instIds = new Set();
  for (const [idx, inst] of s.instances.entries()) {
    if (!inst.id) errors.push(`instances[${idx}] 缺少 id`);
    if (instIds.has(inst.id)) errors.push(`实例 id 重复：${inst.id}`);
    instIds.add(inst.id);
    if (!nodeIds.has(inst.node)) {
      errors.push(`实例 ${inst.id} 引用了不存在的节点：${inst.node}`);
    }
    if (!(inst.cpu > 0)) errors.push(`实例 ${inst.id} 的 cpu 必须为正数`);
    if (!(inst.mem > 0)) errors.push(`实例 ${inst.id} 的 mem 必须为正数`);
    if (!(inst.duration > 0)) errors.push(`实例 ${inst.id} 的 duration 必须为正数`);
    for (const w of inst.noEvict ?? []) {
      if (!Array.isArray(w) || w.length !== 2 || !(w[0] < w[1]) || w[0] < 0) {
        errors.push(`实例 ${inst.id} 的不可驱逐时段 ${JSON.stringify(w)} 无效，应为 [start,end) 且 start<end`);
      }
    }
  }

  const used = usedCapacity(s, Object.fromEntries(s.instances.map((i) => [i.id, i.node])));
  for (const n of s.nodes) {
    const u = used[n.id] ?? { cpu: 0, mem: 0 };
    if (u.cpu > n.cpu || u.mem > n.mem) {
      errors.push(
        `初始放置已超过 ${n.id} 容量：CPU ${u.cpu}/${n.cpu}，内存 ${u.mem}/${n.mem}`,
      );
    }
  }

  const initialRack = evaluateRackPolicy(s, Object.fromEntries(s.instances.map((i) => [i.id, i.node])));
  if (!initialRack.ok) {
    for (const r of initialRack.reasons) errors.push(`初始状态不满足机架冗余：${r.message}`);
  }
  return errors;
}

export function createInitialRuntime(input, objective = 'balanced') {
  const scenario = normalizeScenario(input);
  const disabledNodes = scenario.nodes
    .filter((n) => n.status === 'unavailable' || n.schedulable === false)
    .map((n) => n.id);
  const placements = Object.fromEntries(scenario.instances.map((i) => [i.id, i.node]));
  const runtime = {
    scenario,
    objective,
    disabledNodes,
    placements,
    clock: 0,
    executed: [],
    migrated: {},
    finalized: {},
    plan: null,
    lastReplan: null,
  };
  runtime.plan = planFromRuntime(runtime, objective);
  return runtime;
}

export function getPolicy(scenario, service) {
  const specific = scenario.policies?.services?.[service] ?? {};
  return {
    minReady: specific.minReady ?? scenario.policies?.defaultMinReady ?? 0,
    minRacks: specific.minRacks ?? scenario.policies?.defaultMinRacks ?? 0,
    maxPerRack: specific.maxPerRack ?? scenario.policies?.defaultMaxPerRack ?? INF,
  };
}

export function getNode(scenario, nodeId) {
  return scenario.nodes.find((n) => n.id === nodeId);
}

export function usedCapacity(scenario, placements) {
  const used = {};
  for (const n of scenario.nodes) used[n.id] = { cpu: 0, mem: 0 };
  for (const inst of scenario.instances) {
    const nodeId = placements[inst.id];
    if (!nodeId || !used[nodeId]) continue;
    used[nodeId].cpu += inst.cpu;
    used[nodeId].mem += inst.mem;
  }
  return used;
}

export function rackSnapshot(scenario, placements) {
  const groups = {};
  for (const inst of scenario.instances) {
    const nodeId = placements[inst.id];
    if (nodeId == null) continue;
    const node = getNode(scenario, nodeId);
    if (!node) continue;
    const key = inst.service ?? 'default';
    groups[key] ??= { ready: 0, racks: {}, nodes: {} };
    groups[key].ready += 1;
    groups[key].racks[node.rack] = (groups[key].racks[node.rack] ?? 0) + 1;
    groups[key].nodes[nodeId] = (groups[key].nodes[nodeId] ?? 0) + 1;
  }
  return groups;
}

export function evaluateRackPolicy(scenario, placements) {
  const snap = rackSnapshot(scenario, placements);
  const reasons = [];
  const services = new Set([
    ...scenario.instances.map((i) => i.service ?? 'default'),
    ...Object.keys(scenario.policies?.services ?? {}),
  ]);

  for (const service of services) {
    const p = getPolicy(scenario, service);
    const g = snap[service] ?? { ready: 0, racks: {} };
    const rackCount = Object.keys(g.racks ?? {}).length;
    if (g.ready < p.minReady) {
      reasons.push({
        code: 'RACK_MIN_READY',
        constraint: '机架冗余 / 最小可用副本',
        service,
        message: `服务 ${service} 当前可用副本 ${g.ready}，低于 minReady=${p.minReady}`,
      });
    }
    if (rackCount < p.minRacks) {
      reasons.push({
        code: 'RACK_MIN_RACKS',
        constraint: '机架冗余 / 跨机架数',
        service,
        message: `服务 ${service} 仅分布在 ${rackCount} 个机架，低于 minRacks=${p.minRacks}`,
      });
    }
    for (const [rack, count] of Object.entries(g.racks ?? {})) {
      if (count > p.maxPerRack) {
        reasons.push({
          code: 'RACK_MAX_PER_RACK',
          constraint: '机架冗余 / 单机架副本上限',
          service,
          rack,
          message: `服务 ${service} 在机架 ${rack} 有 ${count} 个副本，超过 maxPerRack=${p.maxPerRack}`,
        });
      }
    }
  }
  return { ok: reasons.length === 0, reasons, snapshot: snap };
}

export function durationForTarget(inst, target) {
  const override = inst?.durationOverrides?.[target?.id];
  if (Number.isFinite(override)) return override;
  const factor = target?.durationFactor ?? 1;
  return Math.max(1, Math.round((inst?.duration ?? 1) * factor));
}

export function earliestInterval(inst, earliest = 0, horizon = DEFAULT_HORIZON, target = null) {
  const duration = durationForTarget(inst, target);
  const windows = [...(inst.noEvict ?? [])]
    .map(([a, b]) => [Number(a), Number(b)])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  let start = Math.max(0, Math.ceil(earliest));
  let guard = 0;
  while (guard++ < 1000) {
    if (start + duration > horizon) {
      return {
        start: null,
        end: null,
        feasible: false,
        code: 'WINDOW_HORIZON',
        message: `在规划时域 ${horizon} 槽内找不到长度 ${duration} 且避开不可驱逐时段的区间`,
      };
    }
    const end = start + duration;
    const hit = windows.find(([a, b]) => start < b && end > a);
    if (!hit) return { start, end, feasible: true, waitSlots: start - earliest };
    // 与 [a,b) 相交：只能等到该保护窗口结束后再试。
    start = Math.max(start + 1, hit[1]);
  }
  return { start: null, end: null, feasible: false, code: 'WINDOW_LOOP', message: '不可驱逐时段求解失败' };
}

export function isTargetEligible(node, scenario, disabledNodes = []) {
  if (!node) return { ok: false, code: 'NO_NODE', message: '目标节点不存在' };
  if (disabledNodes.includes(node.id)) {
    return { ok: false, code: 'NODE_TEMP_UNAVAILABLE', constraint: '备用机可用性', message: `${node.id} 已被临时标记为不可用` };
  }
  if (node.status === 'unavailable') {
    return { ok: false, code: 'NODE_UNAVAILABLE', constraint: '节点可用性', message: `${node.id} 状态为 unavailable` };
  }
  if (node.schedulable === false) {
    return { ok: false, code: 'NODE_CORDONED', constraint: '节点可调度性', message: `${node.id} 已封锁调度` };
  }
  if (node.replace === true) {
    return { ok: false, code: 'NODE_BEING_REPLACED', constraint: '节点替换范围', message: `${node.id} 是待替换/排空节点，不能作为接收目标` };
  }
  return { ok: true };
}

export function evaluateCandidate(scenario, state, instanceId, targetId, now = state.clock ?? 0) {
  const inst = scenario.instances.find((i) => i.id === instanceId);
  const target = getNode(scenario, targetId);
  const sourceId = state.placements?.[instanceId] ?? inst.node;
  const source = getNode(scenario, sourceId);
  const disabled = state.disabledNodes ?? [];
  const reasons = [];

  if (!inst) return { feasible: false, reasons: [{ code: 'NO_INSTANCE', message: `未知实例 ${instanceId}` }] };
  if (!target) return { feasible: false, reasons: [{ code: 'NO_TARGET', message: `未知目标 ${targetId}` }] };

  const eligibility = isTargetEligible(target, scenario, disabled);
  if (!eligibility.ok) reasons.push(eligibility);

  // 动作开始：旧位置副本被驱逐，实例在迁移期间不可用。
  const midPlacements = { ...state.placements, [instanceId]: null };
  const disruption = evaluateRackPolicy(scenario, midPlacements);
  if (!disruption.ok) reasons.push(...disruption.reasons);

  // 容量按“源副本已摘除、目标已预留”的中间状态检查。
  const midUsed = usedCapacity(scenario, midPlacements);
  const targetUsed = midUsed[targetId] ?? { cpu: 0, mem: 0 };
  const cpuFree = target.cpu - targetUsed.cpu;
  const memFree = target.mem - targetUsed.mem;
  const capacity = {
    cpuFree,
    memFree,
    cpuNeed: inst.cpu,
    memNeed: inst.mem,
    fits: cpuFree >= inst.cpu && memFree >= inst.mem,
  };
  if (eligibility.ok && !capacity.fits) {
    reasons.push({
      code: 'CAPACITY_INSUFFICIENT',
      constraint: '可用容量',
      message: `${targetId} 剩余 CPU ${cpuFree}/${inst.cpu}、内存 ${memFree}/${inst.mem}，放不下 ${instanceId}`,
      capacity,
    });
  }

  const interval = earliestInterval(inst, now, scenario.horizon, target);
  if (!interval.feasible) {
    reasons.push({
      code: 'EVICTION_WINDOW',
      constraint: '实例不可驱逐时段',
      message: `${instanceId}（${(inst.noEvict ?? []).map((w) => `[${w[0]},${w[1]})`).join('、') || '无'}）从 ${now} 槽起无可执行区间：${interval.message}`,
    });
  }

  // 动作结束：副本在目标机架恢复 ready，检查机架离散/上限。
  const finalPlacements = { ...state.placements, [instanceId]: targetId };
  const completionRack = evaluateRackPolicy(scenario, finalPlacements);
  if (!completionRack.ok) reasons.push(...completionRack.reasons);

  const crossRack = source && target ? source.rack !== target.rack : false;
  const step = {
    id: `migrate:${instanceId}`,
    kind: 'migrate',
    instanceId,
    service: inst.service,
    from: sourceId,
    to: targetId,
    rackFrom: source?.rack,
    rackTo: target.rack,
    crossRack,
    cpu: inst.cpu,
    mem: inst.mem,
    volumeGb: inst.volumeGb ?? 0,
    duration: interval.feasible ? interval.end - interval.start : durationForTarget(inst, target),
    baseDuration: inst.duration,
    waitSlots: interval.feasible ? interval.waitSlots : null,
    start: interval.start,
    end: interval.end,
  };

  return {
    feasible: reasons.length === 0,
    reasons,
    capacity,
    interval,
    step,
  };
}

function stateKey(remaining, placements) {
  return stableStringify({
    r: [...remaining].sort(),
    p: placements,
  });
}

function paretoNondominated(plans) {
  const nondominated = [];
  for (const p of plans) {
    const dominated = plans.some(
      (q) =>
        q !== p &&
        q.completionAt <= p.completionAt &&
        q.crossRack <= p.crossRack &&
        (q.completionAt < p.completionAt || q.crossRack < p.crossRack),
    );
    if (!dominated) nondominated.push(p);
  }

  // 页面前沿按指标展示；同一 (完工时间, 跨机架数) 只保留字典序最稳定的代表序列。
  const groups = new Map();
  for (const p of nondominated) {
    const key = `${p.completionAt}:${p.crossRack}`;
    const existing = groups.get(key);
    if (!existing || p.signature < existing.signature) {
      groups.set(key, { ...p, equivalentSequenceCount: existing?.equivalentSequenceCount ?? 1 });
    } else {
      existing.equivalentSequenceCount += 1;
    }
  }
  return [...groups.values()].sort(
    (a, b) => a.completionAt - b.completionAt || a.crossRack - b.crossRack,
  );
}

function chooseFromFront(front, objective = 'balanced') {
  if (!front.length) return null;
  if (objective === 'fastest') return front[0]; // 已按完工时间、cross 排序
  if (objective === 'low-cross') {
    return [...front].sort((a, b) => a.crossRack - b.crossRack || a.completionAt - b.completionAt)[0];
  }
  const minTime = Math.min(...front.map((p) => p.completionAt));
  const maxTime = Math.max(...front.map((p) => p.completionAt));
  const minCross = Math.min(...front.map((p) => p.crossRack));
  const maxCross = Math.max(...front.map((p) => p.crossRack));
  const timeSpan = maxTime - minTime || 1;
  const crossSpan = maxCross - minCross || 1;
  const scored = front.map((p) => ({
    p,
    score:
      0.5 * ((p.completionAt - minTime) / timeSpan) +
      0.5 * ((p.crossRack - minCross) / crossSpan),
  }));
  scored.sort((a, b) => a.score - b.score || a.p.completionAt - b.completionAt);
  return scored[0].p;
}

export function planFromRuntime(runtime, objective = runtime.objective ?? 'balanced', options = {}) {
  const scenario = runtime.scenario;
  const basePlacements = runtime.placements;
  const baseClock = runtime.clock ?? 0;
  const disabledNodes = runtime.disabledNodes ?? [];
  const migrated = runtime.migrated ?? {};
  const finalized = runtime.finalized ?? {};
  // 只有当前仍位于“待替换/排空节点”上的实例需要迁移；普通固定实例不生成自迁移动作。
  const remaining = scenario.instances
    .map((i) => i.id)
    .filter((id) => {
      if (migrated[id]) return false;
      const nodeId = runtime.placements?.[id];
      return getNode(scenario, nodeId)?.replace === true;
    });
  const maxSolutions = options.maxSolutions ?? 2000;
  const maxIterations = options.maxIterations ?? 100000;

  const solutions = [];
  const deadEnds = [];
  const labels = new Map();
  let iterations = 0;
  let pruned = 0;

  function rememberLabel(key, label) {
    const arr = labels.get(key) ?? [];
    const dominated = arr.some(
      (x) => x.clock <= label.clock && x.crossRack <= label.crossRack,
    );
    if (dominated) return false;
    const next = arr.filter(
      (x) => !(label.clock <= x.clock && label.crossRack <= x.crossRack),
    );
    next.push(label);
    // 保留少量非支配标签，避免异常输入导致状态爆炸。
    next.sort((a, b) => a.clock - b.clock || a.crossRack - b.crossRack);
    labels.set(key, next.slice(0, options.labelsPerState ?? 32));
    return true;
  }

  function appendFinalizeSteps(steps, clock) {
    const finalSteps = [];
    let t = clock;
    const nodes = scenario.nodes
      .filter((n) => n.replace === true && !finalized[n.id])
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const n of nodes) {
      const duration = n.replaceSlots ?? scenario.replaceSlots ?? 1;
      const start = t;
      t += duration;
      finalSteps.push({
        id: `finalize:${n.id}`,
        kind: 'finalize',
        nodeId: n.id,
        node: n.id,
        rack: n.rack,
        duration,
        waitSlots: 0,
        start,
        end: t,
        crossRack: false,
      });
    }
    return { steps: [...steps, ...finalSteps], end: t };
  }

  function dfs(placements, rem, clock, steps, crossRack, crossCpu, waitSlots) {
    iterations += 1;
    if (iterations > maxIterations || solutions.length >= maxSolutions) return;

    if (rem.length === 0) {
      const fin = appendFinalizeSteps(steps, clock);
      const signature = fin.steps
        .map((st) => (st.kind === 'migrate' ? `${st.instanceId}>${st.to}` : st.id))
        .join('|');
      solutions.push({
        steps: fin.steps,
        completionAt: fin.end,
        futureSlots: fin.end - baseClock,
        crossRack,
        crossCpu,
        waitSlots,
        signature,
      });
      return;
    }

    const key = stateKey(rem, placements);
    if (!rememberLabel(key, { clock, crossRack })) {
      pruned += 1;
      return;
    }

    let actionCount = 0;
    for (const instanceId of rem) {
      for (const target of scenario.nodes) {
        const evaluated = evaluateCandidate(
          scenario,
          { placements, clock, disabledNodes },
          instanceId,
          target.id,
          clock,
        );
        if (!evaluated.feasible) continue;
        actionCount += 1;
        const inst = scenario.instances.find((i) => i.id === instanceId);
        const step = { ...evaluated.step };
        const nextPlacements = { ...placements, [instanceId]: target.id };
        const nextRem = rem.filter((id) => id !== instanceId);
        dfs(
          nextPlacements,
          nextRem,
          step.end,
          [...steps, step],
          crossRack + (step.crossRack ? 1 : 0),
          crossCpu + (step.crossRack ? inst.cpu : 0),
          waitSlots + (step.waitSlots ?? 0),
        );
        if (solutions.length >= maxSolutions || iterations > maxIterations) return;
      }
    }

    if (actionCount === 0 && deadEnds.length < 20) {
      const diagnosis = diagnoseState(scenario, {
        placements,
        clock,
        disabledNodes,
        migrated,
        finalized,
      });
      deadEnds.push({
        remaining: [...rem],
        steps: [...steps],
        clock,
        diagnosis,
      });
    }
  }

  dfs(basePlacements, remaining, baseClock, [], 0, 0, 0);

  const truncated = iterations > maxIterations || solutions.length >= maxSolutions;
  const front = paretoNondominated(solutions);
  const selected = chooseFromFront(front, objective);
  const diagnosis = selected
    ? null
    : diagnoseFailure(scenario, {
        placements: basePlacements,
        clock: baseClock,
        disabledNodes,
        migrated,
        finalized,
      }, deadEnds);

  return {
    feasible: Boolean(selected),
    objective,
    remaining,
    plans: front,
    allSolutionCount: solutions.length,
    selected,
    diagnosis,
    truncated,
    stats: { iterations, pruned, paretoCount: front.length },
  };
}

export function diagnoseState(scenario, state) {
  const placements = state.placements;
  const clock = state.clock ?? 0;
  const disabledNodes = state.disabledNodes ?? [];
  const migrated = state.migrated ?? {};
  const pending = scenario.instances.filter((i) => {
    if (migrated[i.id]) return false;
    return getNode(scenario, placements[i.id])?.replace === true;
  });
  const reports = [];

  for (const inst of pending) {
    const targets = scenario.nodes.map((n) => {
      const ev = evaluateCandidate(scenario, state, inst.id, n.id, clock);
      return {
        nodeId: n.id,
        rack: n.rack,
        eligible: isTargetEligible(n, scenario, disabledNodes).ok,
        feasible: ev.feasible,
        reasons: ev.reasons,
        capacity: ev.capacity ?? null,
        interval: ev.interval ?? null,
      };
    });
    reports.push({ instanceId: inst.id, service: inst.service, from: placements[inst.id] ?? inst.node, targets });
  }

  const primary = classifyBlocker(scenario, state, reports);
  return { at: clock, reports, primary };
}

function classifyBlocker(scenario, state, reports) {
  if (!reports.length) return null;

  // 优先采用“最深死路”的分类由 diagnoseFailure 覆盖；这里给当前状态分类。
  const categories = [];
  for (const r of reports) {
    if (r.targets.some((t) => t.feasible)) continue;

    const eligible = r.targets.filter((t) => t.eligible);
    const capacityOk = eligible.some((t) => t.capacity?.fits);
    const windowOk = r.targets.some((t) => t.interval?.feasible);
    const rackReasons = r.targets.flatMap((t) =>
      t.reasons.filter((x) => x.code?.startsWith('RACK_')),
    );

    if (!windowOk) {
      categories.push({
        code: 'EVICTION_WINDOW',
        constraint: '实例不可驱逐时段',
        instanceId: r.instanceId,
        message: `${r.instanceId} 的所有可执行起点都落在不可驱逐窗口或规划时域之外`,
        details: r.targets.flatMap((t) => t.reasons.filter((x) => x.code === 'EVICTION_WINDOW')).slice(0, 3),
      });
    }

    const capacityTargets = eligible.filter((t) => t.capacity && !t.capacity.fits);
    if (!capacityOk) {
      const best = eligible
        .map((t) => ({ t, score: (t.capacity?.cpuFree ?? -INF) + (t.capacity?.memFree ?? -INF) / 16 }))
        .sort((a, b) => b.score - a.score)[0]?.t;
      categories.push({
        code: 'CAPACITY',
        constraint: '可用容量',
        instanceId: r.instanceId,
        message: best
          ? `${r.instanceId} 没有可容纳它的就绪目标；最接近的是 ${best.nodeId}（CPU 空闲 ${best.capacity.cpuFree}，内存空闲 ${best.capacity.memFree}）`
          : `${r.instanceId} 没有未停用且非替换中的目标节点`,
        details: capacityTargets.slice(0, 4).flatMap((t) => t.reasons.filter((x) => x.code === 'CAPACITY_INSUFFICIENT')).slice(0, 4),
      });
    }

    if (capacityOk && windowOk && rackReasons.length) {
      categories.push({
        code: 'RACK_REDUNDANCY',
        constraint: '机架冗余',
        instanceId: r.instanceId,
        message: rackReasons[0].message,
        details: rackReasons.slice(0, 5),
      });
    }
  }

  if (!categories.length) {
    return {
      code: 'SEARCH_DEAD_END',
      constraint: '动作顺序/资源碎片',
      message: '当前存在局部可执行动作，但所有顺序都会在后续进入死路；请查看最深阻塞点。',
    };
  }

  // 容量通常是硬资源；窗口和机架分别返回，UI 可显示全部。
  const rank = { CAPACITY: 0, EVICTION_WINDOW: 1, RACK_REDUNDANCY: 2, SEARCH_DEAD_END: 3 };
  categories.sort((a, b) => rank[a.code] - rank[b.code]);
  return categories[0];
}

export function diagnoseFailure(scenario, state, deadEnds = []) {
  if (deadEnds.length) {
    const deepest = [...deadEnds].sort((a, b) => b.steps.length - a.steps.length)[0];
    const primary = deepest.diagnosis.primary;
    return {
      ...deepest.diagnosis,
      primary: primary
        ? {
            ...primary,
            afterSteps: deepest.steps.map((s) => s.id),
            remaining: deepest.remaining,
            message: `保留已执行前缀后，未来动作推演到第 ${deepest.steps.length} 步进入死路：${primary.message}`,
          }
        : null,
      deadEnds: deadEnds.slice(0, 5),
    };
  }
  return diagnoseState(scenario, state);
}

export function executeCandidate(runtime, instanceId, targetId) {
  const evaluated = evaluateCandidate(runtime.scenario, runtime, instanceId, targetId, runtime.clock ?? 0);
  if (!evaluated.feasible) {
    return { ok: false, error: '该动作当前不安全', reasons: evaluated.reasons, evaluated };
  }
  const step = clone(evaluated.step);
  runtime.placements[step.instanceId] = step.to;
  runtime.migrated[step.instanceId] = true;
  runtime.clock = step.end;
  runtime.executed.push({ ...step, status: 'executed' });
  runtime.plan = planFromRuntime(runtime, runtime.objective);
  runtime.lastReplan = { at: runtime.clock, reason: `manual:${instanceId}>${targetId}` };
  return { ok: true, executedStep: step, plan: runtime.plan };
}

export function executeNext(runtime, stepId = null) {
  const plan = runtime.plan;
  if (!plan?.feasible || !plan.selected) {
    return { ok: false, error: '当前没有可执行计划，请先解除阻塞或重新规划。' };
  }
  const nextFutureStep = plan.selected.steps[0];
  if (!nextFutureStep) return { ok: false, error: '计划中没有动作。' };
  if (stepId && nextFutureStep.id !== stepId) {
    return { ok: false, error: `只能执行重排后的第一个未执行动作：${nextFutureStep.id}` };
  }

  const step = clone(nextFutureStep);
  if (step.kind === 'migrate') {
    runtime.placements[step.instanceId] = step.to;
    runtime.migrated[step.instanceId] = true;
  } else if (step.kind === 'finalize') {
    runtime.finalized[step.nodeId ?? step.node] = true;
  }
  runtime.clock = step.end;
  runtime.executed.push({ ...step, status: 'executed' });
  runtime.plan = planFromRuntime(runtime, runtime.objective);
  runtime.lastReplan = { at: runtime.clock, reason: 'execute-next' };
  return { ok: true, executedStep: step, plan: runtime.plan };
}

export function setNodeAvailability(runtime, nodeId, unavailable) {
  const node = getNode(runtime.scenario, nodeId);
  if (!node) return { ok: false, error: `未知节点 ${nodeId}` };
  const set = new Set(runtime.disabledNodes ?? []);
  if (unavailable) set.add(nodeId);
  else set.delete(nodeId);
  runtime.disabledNodes = [...set];
  runtime.plan = planFromRuntime(runtime, runtime.objective);
  runtime.lastReplan = {
    at: runtime.clock,
    reason: unavailable ? `mark-unavailable:${nodeId}` : `restore:${nodeId}`,
    preserveExecuted: runtime.executed.map((s) => s.id),
  };
  return { ok: true, plan: runtime.plan };
}

export function setObjective(runtime, objective) {
  runtime.objective = objective;
  if (runtime.plan?.plans?.length) {
    runtime.plan.selected = chooseFromFront(runtime.plan.plans, objective);
    runtime.plan.objective = objective;
  } else {
    runtime.plan = planFromRuntime(runtime, objective);
  }
  return runtime.plan;
}

export function totalMetrics(runtime, plan = runtime.plan?.selected) {
  const executedCross = runtime.executed.filter((s) => s.kind === 'migrate' && s.crossRack).length;
  const executedCrossCpu = runtime.executed
    .filter((s) => s.kind === 'migrate' && s.crossRack)
    .reduce((sum, s) => sum + (s.cpu ?? 0), 0);
  if (!plan) {
    return {
      completionAt: runtime.clock,
      crossRack: executedCross,
      crossCpu: executedCrossCpu,
      executedCount: runtime.executed.length,
      futureCount: 0,
    };
  }
  return {
    completionAt: plan.completionAt,
    crossRack: executedCross + plan.crossRack,
    crossCpu: executedCrossCpu + plan.crossCpu,
    executedCount: runtime.executed.length,
    futureCount: plan.steps.length,
  };
}

// 检查相邻交换，生成“为什么这个顺序不可换”的解释。
export function analyzeOrderConstraints(scenario, runtime, plan) {
  const bullets = [];
  if (!plan?.steps?.length) return bullets;
  const executed = runtime.executed ?? [];

  // 从当前 runtime 状态开始，只分析未来步骤。
  let placements = { ...runtime.placements };
  let clock = runtime.clock ?? 0;
  let beforePreviousMigrate = null;
  const baseState = { placements: { ...runtime.placements }, clock: runtime.clock ?? 0 };
  const afterSnapshots = [];
  const disabledNodes = runtime.disabledNodes ?? [];

  for (let idx = 0; idx < plan.steps.length; idx += 1) {
    const step = plan.steps[idx];
    if (step.kind !== 'migrate') continue;

    // 当前状态就是该步骤执行前；保存它，供下一步做“与前一步交换”的检查。
    const beforeThis = { placements, clock };

    if ((step.waitSlots ?? 0) > 0) {
      const inst = scenario.instances.find((i) => i.id === step.instanceId);
      bullets.push({
        type: 'window',
        stepId: step.id,
        text: `${step.instanceId} 在 ${clock} 槽后需等待 ${step.waitSlots} 槽，以避开不可驱逐时段 ${(inst?.noEvict ?? []).map((w) => `[${w[0]},${w[1]})`).join('、')}，${step.start}→${step.end} 槽执行。`,
      });
    }

    if (idx > 0) {
      const prev = plan.steps[idx - 1];
      if (prev.kind === 'migrate' && beforePreviousMigrate) {
        const swapped = evaluateCandidate(
          scenario,
          {
            placements: beforePreviousMigrate.placements,
            clock: beforePreviousMigrate.clock,
            disabledNodes,
          },
          step.instanceId,
          step.to,
          beforePreviousMigrate.clock,
        );
        if (!swapped.feasible) {
          const keyReason = swapped.reasons.find((r) => r.code?.startsWith('RACK_'))
            ?? swapped.reasons.find((r) => r.code === 'CAPACITY_INSUFFICIENT')
            ?? swapped.reasons.find((r) => r.code === 'EVICTION_WINDOW');
          if (keyReason) {
            bullets.push({
              type: keyReason.code.startsWith('RACK_') ? 'rack-order' : keyReason.code === 'EVICTION_WINDOW' ? 'window-order' : 'capacity-order',
              stepId: step.id,
              text: `不能把 ${step.instanceId} 提到 ${prev.instanceId} 之前：${keyReason.message}；先执行 ${prev.instanceId}→${prev.to} 后该动作才安全。`,
            });
          }
        }
      }
    }

    if (
      !bullets.some((b) => b.stepId === step.id && b.type === 'rack-order')
    ) {
      const initialEval = evaluateCandidate(
        scenario,
        { placements: baseState.placements, clock: baseState.clock, disabledNodes },
        step.instanceId,
        step.to,
        baseState.clock,
      );
      const initialRackReason = initialEval.reasons.find((r) => r.code?.startsWith('RACK_'));
      if (initialRackReason) {
        for (const snapshot of afterSnapshots) {
          const afterEval = evaluateCandidate(
            scenario,
            { placements: snapshot.placements, clock: snapshot.clock, disabledNodes },
            step.instanceId,
            step.to,
            snapshot.clock,
          );
          if (!afterEval.reasons.some((r) => r.code?.startsWith('RACK_'))) {
            bullets.push({
              type: 'rack-order',
              stepId: step.id,
              text: `初始状态下不能先处理 ${step.instanceId}：${initialRackReason.message}；直到 ${snapshot.step.instanceId}→${snapshot.step.to} 完成后，机架约束才解除。`,
            });
            break;
          }
        }
      }
    }

    placements = { ...placements, [step.instanceId]: step.to };
    clock = step.end;
    beforePreviousMigrate = beforeThis;
    afterSnapshots.push({ step, placements, clock });
  }

  for (const step of plan.steps.filter((s) => s.crossRack)) {
    bullets.push({
      type: 'cross',
      stepId: step.id,
      text: `${step.instanceId} 从 ${step.rackFrom} 迁到 ${step.rackTo}，计为 1 次跨机架迁移（${step.volumeGb || 0} GiB）。`,
    });
  }
  return bullets;
}

export function compareSelectedPlans(scenario, runtime, planA, planB) {
  const a = planA;
  const b = planB;
  let firstDifference = null;
  const max = Math.max(a?.steps.length ?? 0, b?.steps.length ?? 0);
  for (let i = 0; i < max; i += 1) {
    const sa = a?.steps[i];
    const sb = b?.steps[i];
    if ((sa?.signature ?? sa?.id) !== (sb?.signature ?? sb?.id) || sa?.to !== sb?.to) {
      firstDifference = { index: i, a: sa, b: sb };
      break;
    }
  }
  return {
    firstDifference,
    metrics: {
      a: a ? { completionAt: a.completionAt, crossRack: a.crossRack, waitSlots: a.waitSlots } : null,
      b: b ? { completionAt: b.completionAt, crossRack: b.crossRack, waitSlots: b.waitSlots } : null,
    },
  };
}
