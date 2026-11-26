import {
  normalizeScenario,
  validateScenario,
  createInitialRuntime,
  setObjective,
  setNodeAvailability,
  executeNext,
  executeCandidate,
  totalMetrics,
  usedCapacity,
  analyzeOrderConstraints,
  compareSelectedPlans,
} from './engine.js';
import {
  presets,
  tradeoffScenario,
  capacityBlockScenario,
  rackBlockScenario,
  strictComparisonScenario,
  relaxedComparisonScenario,
} from './examples.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

let scenario = tradeoffScenario;
let runtime = createInitialRuntime(scenario, 'balanced');
const compareRuntimes = [
  createInitialRuntime(strictComparisonScenario, 'fastest'),
  createInitialRuntime(relaxedComparisonScenario, 'fastest'),
];

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3600);
}

function loadScenario(nextScenario, objective = runtime?.objective ?? 'balanced') {
  scenario = normalizeScenario(nextScenario);
  runtime = createInitialRuntime(scenario, objective);
  $('#scenario-json').value = JSON.stringify(scenario, null, 2);
  renderValidation([]);
  renderAll();
}

function renderValidation(errors) {
  const el = $('#validation');
  if (!errors.length) {
    el.className = 'validation ok';
    el.innerHTML = '✅ JSON 与初始约束校验通过。';
  } else {
    el.className = 'validation err';
    el.innerHTML = `❌ 发现 ${errors.length} 个问题：<ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`;
  }
}

function renderPresets() {
  const strip = $('#preset-strip');
  strip.innerHTML = presets
    .map((p) => {
      const active = p.id === scenario.id;
      const kind =
        p.id === 'tradeoff-bay'
          ? '多目标 Pareto'
          : p.id === 'capacity-block'
            ? '容量扰动'
            : p.id === 'rack-block'
              ? '机架扰动'
              : '约束对照';
      return `
        <button class="preset-card" type="button" data-action="load-preset" data-id="${esc(p.id)}" aria-pressed="${active}">
          <span class="preset-title">${esc(p.title)}</span>
          <span class="preset-meta">${esc(kind)} · ${p.nodes.length} 节点 · ${p.instances.length} 实例</span>
        </button>`;
    })
    .join('');
}

function objectiveLabel(o) {
  return o === 'fastest' ? '最快完工' : o === 'low-cross' ? '最少跨机架' : '均衡取舍';
}

function crossVolume(steps) {
  return steps
    .filter((s) => s.kind === 'migrate' && s.crossRack)
    .reduce((sum, s) => sum + (s.volumeGb ?? 0), 0);
}

function renderMetrics() {
  const selected = runtime.plan?.selected;
  const m = totalMetrics(runtime, selected);
  const totalCrossVolume =
    runtime.executed.reduce((sum, s) => sum + (s.crossRack ? s.volumeGb ?? 0 : 0), 0) +
    crossVolume(selected?.steps ?? []);
  const totalFutureActions = selected?.steps.length ?? 0;
  const tiles = [
    { label: '当前逻辑时钟', value: runtime.clock, hint: '已执行动作推进到的槽位' },
    {
      label: '预计完工',
      value: selected ? `${m.completionAt} 槽` : '阻塞',
      hint: selected ? `剩余 ${totalFutureActions} 个动作（含收尾）` : '没有完整安全序列',
    },
    { label: '跨机架迁移', value: `${m.crossRack} 次`, hint: `约 ${totalCrossVolume} GiB 搬运量` },
    { label: '已执行 / Pareto', value: `${m.executedCount} / ${runtime.plan?.plans.length ?? 0}`, hint: '已固定动作 / 非支配方案点' },
  ];
  $('#metric-grid').innerHTML = tiles
    .map(
      (t) => `
      <div class="metric">
        <div class="label">${esc(t.label)}</div>
        <div class="value">${esc(t.value)}</div>
        <div class="hint">${esc(t.hint)}</div>
      </div>`,
    )
    .join('');

  const badge = $('#feasibility-badge');
  if (runtime.plan?.feasible) {
    badge.className = 'badge good';
    badge.textContent = runtime.disabledNodes.length ? `已扰动 · 仍可重排` : `可行 · ${runtime.plan.plans.length} 个 Pareto 点`;
  } else {
    badge.className = 'badge critical';
    badge.textContent = '约束阻塞';
  }

  $$('[data-objective]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.objective === runtime.objective));
  });
  $('#scenario-description').textContent = scenario.description;
}

function blockerSuggestion(code) {
  if (code === 'CAPACITY') return '恢复被停用的备用机、调大目标节点 CPU/内存，或减少待迁移实例规格。';
  if (code === 'RACK_REDUNDANCY' || code?.startsWith?.('RACK_')) return '恢复相关机架的备用目标、放宽 minRacks/maxPerRack，或增加该机架上的冗余副本。';
  if (code === 'EVICTION_WINDOW') return '后移规划时域 horizon、调整 noEvict 窗口，或先执行其他动作等到窗口结束。';
  return '可恢复备用机、编辑约束后重新规划，或重置执行状态。';
}

function renderBlocker() {
  const slot = $('#blocker-slot');
  const plan = runtime.plan;
  if (!plan?.feasible && plan?.diagnosis?.primary) {
    const p = plan.diagnosis.primary;
    const details = (p.details ?? []).slice(0, 4).map((d) => `<li>${esc(d.message)}</li>`).join('');
    slot.innerHTML = `
      <div class="callout critical" role="alert">
        <strong>⛔ ${esc(p.constraint)}卡住：${esc(p.code)}</strong>
        <div>${esc(p.message)}</div>
        ${details ? `<ul>${details}</ul>` : ''}
        <div style="margin-top:8px"><strong>解锁建议</strong>：${esc(blockerSuggestion(p.code))}</div>
      </div>`;
    return;
  }
  if ((runtime.lastReplan?.reason ?? '').startsWith('mark-unavailable')) {
    slot.innerHTML = `
      <div class="callout warning">
        <strong>备用机已临时不可用，计划已重排</strong>
        <div>已保留 ${runtime.executed.length} 个执行动作；下面时间线中绿色动作已固定，蓝色/橙色动作是只针对未执行部分的新序列。</div>
      </div>`;
    return;
  }
  if (plan?.truncated) {
    slot.innerHTML = `<div class="callout warning"><strong>搜索触发有界上限</strong><div>当前输入较大，结果可能不是完整 Pareto 前沿；可减少节点/实例或调大搜索上限。</div></div>`;
    return;
  }
  slot.innerHTML = '';
}

function renderPareto() {
  const el = $('#pareto-list');
  const plan = runtime.plan;
  if (!plan?.feasible) {
    el.innerHTML = `<div class="empty">无可行 Pareto 序列。</div>`;
    return;
  }
  el.innerHTML = plan.plans
    .map((p, i) => {
      const selected = runtime.plan.selected === p || runtime.plan.selected?.signature === p.signature;
      const migrateCount = p.steps.filter((s) => s.kind === 'migrate').length;
      return `
        <button class="pareto-point" type="button" data-action="select-plan" data-index="${i}" aria-pressed="${selected}">
          <strong>⏱ ${p.completionAt} 槽 · 🌐 ${p.crossRack} 次</strong>
          <span>${migrateCount} 个迁移 · 等待 ${p.waitSlots} 槽 · 约 ${p.equivalentSequenceCount ?? 1} 个同指标序列</span>
        </button>`;
    })
    .join('');
}

function renderGantt() {
  const slot = $('#gantt-slot');
  const selected = runtime.plan?.selected;
  const future = selected?.steps ?? [];
  const steps = [...runtime.executed, ...future];
  if (!steps.length) {
    slot.innerHTML = `<div class="empty">暂无可显示动作。</div>`;
    return;
  }
  const horizon = Math.max(scenario.horizon ?? 12, ...steps.map((s) => s.end ?? 0), runtime.clock + 1);
  const ticks = [];
  const tickStep = horizon > 14 ? 2 : 1;
  for (let t = 0; t <= horizon; t += tickStep) ticks.push(t);

  const rows = steps
    .map((s) => {
      const isExecuted = runtime.executed.includes(s);
      const waitStart = (s.start ?? 0) - (s.waitSlots ?? 0);
      const waitWidth = s.waitSlots ? (s.waitSlots / horizon) * 100 : 0;
      const left = ((s.start ?? 0) / horizon) * 100;
      const width = Math.max(1.8, (((s.end ?? s.start + s.duration) - s.start) / horizon) * 100);
      const cls = [
        'gantt-bar',
        s.kind === 'finalize' ? 'finalize' : '',
        s.crossRack ? 'cross' : '',
        isExecuted ? 'executed' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const name = s.kind === 'finalize' ? `更换 ${s.nodeId}` : s.instanceId;
      const sub = s.kind === 'finalize' ? '收尾动作' : `${s.from}→${s.to}${s.crossRack ? ' · 跨机架' : ''}`;
      return `
        <div class="gantt-row">
          <div class="gantt-label"><strong title="${esc(name)}">${esc(name)}</strong><span>${esc(sub)}</span></div>
          <div class="gantt-track" style="--horizon:${horizon}">
            ${s.waitSlots ? `<div class="gantt-bar wait" title="等待 ${s.waitSlots} 槽以避开不可驱逐时段" style="left:${(waitStart / horizon) * 100}%;width:${waitWidth}%"></div>` : ''}
            <div class="${cls}" title="${esc(name)} ${esc(sub)} [${s.start},${s.end})" style="left:${left}%;width:${width}%">
              ${esc(s.duration)}槽
            </div>
          </div>
        </div>`;
    })
    .join('');

  const nowPct = Math.min(100, (runtime.clock / horizon) * 100);
  slot.innerHTML = `
    <div class="gantt-wrap" aria-label="计划甘特图">
      <div class="gantt-axis" style="--horizon:${horizon}">
        ${ticks.map((t) => `<span class="gantt-tick" style="left:${(t / horizon) * 100}%">${t}</span>`).join('')}
        <span class="gantt-now" style="left:${nowPct}%"></span>
      </div>
      ${rows}
    </div>`;
}

function renderStepList() {
  const el = $('#step-list');
  const selected = runtime.plan?.selected;
  const future = selected?.steps ?? [];
  const executedItems = runtime.executed.map((s, i) => renderStepItem(s, i, true));
  const futureItems = future.map((s, i) => renderStepItem(s, runtime.executed.length + i, false, i === 0 && runtime.plan.feasible));
  el.innerHTML = [...executedItems, ...futureItems].join('');
}

function renderStepItem(s, index, executed, next = false) {
  const title = s.kind === 'finalize' ? `更换/下线节点 ${s.nodeId}` : `迁移 ${s.instanceId}：${s.from} → ${s.to}`;
  const detail =
    s.kind === 'finalize'
      ? `节点位于 ${s.rack}，排空完成后的硬件更换/摘除动作。`
      : `${s.service} · ${s.rackFrom}→${s.rackTo} · CPU ${s.cpu} · 内存 ${s.mem} · ${s.volumeGb} GiB`;
  return `
    <li class="step-item ${executed ? 'executed' : ''} ${next ? 'blocked-next' : ''}">
      <span class="step-index" aria-hidden="true">${executed ? '✓' : index + 1}</span>
      <div>
        <div class="step-title">${esc(title)} ${next ? '<span class="badge blue">下一步</span>' : ''}</div>
        <div class="step-detail">${esc(detail)}</div>
        <div class="plan-meta" style="margin:6px 0 0">
          ${s.crossRack ? '<span class="badge orange">跨机架</span>' : s.kind === 'migrate' ? '<span class="badge">同机架</span>' : ''}
          ${s.waitSlots > 0 ? `<span class="badge warning">等待 ${s.waitSlots} 槽避窗口</span>` : ''}
          ${executed ? '<span class="badge good">已执行，不重排</span>' : '<span class="badge violet">未执行，可重排</span>'}
        </div>
      </div>
      <div class="step-time">[${s.start}, ${s.end})<br />${s.duration} 槽</div>
    </li>`;
}

function renderRationale() {
  const el = $('#rationale-list');
  const selected = runtime.plan?.selected;
  if (!selected) {
    el.innerHTML = `<li><span class="tag capacity-order">阻塞</span><span>当前没有完整安全序列；请查看上方约束诊断。</span></li>`;
    return;
  }
  const bullets = analyzeOrderConstraints(scenario, runtime, selected);
  const objectiveBullet = {
    type: 'objective',
    text:
      runtime.objective === 'fastest'
        ? '当前按钮优先压缩绝对完工时间，因此可能选择更多跨机架但更快/更早的目标。'
        : runtime.objective === 'low-cross'
          ? '当前按钮优先减少跨机架次数；只要仍安全，宁可等待不可驱逐窗口或使用较慢的同机架备用机。'
          : '当前选择 Pareto 前沿上的归一化均衡点，在完工时间和跨机架次数之间取折中。',
  };
  const all = [objectiveBullet, ...bullets].slice(0, 10);
  const tagText = { objective: '目标', window: '窗口', 'window-order': '顺序/窗口', 'rack-order': '机架顺序', cross: '跨机架', 'capacity-order': '容量顺序' };
  el.innerHTML = all
    .map(
      (b) => `
      <li>
        <span class="tag ${esc(b.type)}">${esc(tagText[b.type] ?? '说明')}</span>
        <span>${esc(b.text)}</span>
      </li>`,
    )
    .join('');
}

function renderRuntimeTopology() {
  const used = usedCapacity(scenario, runtime.placements);
  const racks = [...new Set(scenario.nodes.map((n) => n.rack))].sort();
  $('#runtime-summary').innerHTML = `
    <div class="plan-meta">
      <span class="badge blue">clock=${runtime.clock}</span>
      <span class="badge ${runtime.disabledNodes.length ? 'critical' : 'good'}">停用：${runtime.disabledNodes.length ? esc(runtime.disabledNodes.join(', ')) : '无'}</span>
    </div>`;
  $('#executed-chain').innerHTML = `
    <h3>已固定的执行前缀</h3>
    ${
      runtime.executed.length
        ? `<div class="executed-chain">${runtime.executed.map((s) => `<span class="chain-chip" title="${esc(s.id)}">✓ ${esc(s.kind === 'migrate' ? s.instanceId : s.nodeId)}</span>`).join('')}</div>`
        : '<div class="empty">尚未执行动作</div>'
    }`;

  $('#rack-grid').innerHTML = racks
    .map((rack) => {
      const nodes = scenario.nodes.filter((n) => n.rack === rack);
      return `
        <div class="rack">
          <div class="rack-head"><span class="rack-name">机架 ${esc(rack)}</span><span class="badge">${nodes.length} 节点</span></div>
          ${nodes.map((n) => renderNode(n, used[n.id] ?? { cpu: 0, mem: 0 })).join('')}
        </div>`;
    })
    .join('');
}

function capBar(usedValue, cap) {
  const pct = cap > 0 ? Math.min(100, (usedValue / cap) * 100) : 0;
  const cls = pct >= 95 ? 'full' : pct >= 80 ? 'warn' : '';
  return `<div class="cap-bar"><i class="${cls}" style="width:${pct}%"></i></div>`;
}

function renderNode(node, u) {
  const disabled = runtime.disabledNodes.includes(node.id) || node.status === 'unavailable';
  const instancesHere = scenario.instances.filter((i) => runtime.placements[i.id] === node.id);
  const cpuFree = node.cpu - u.cpu;
  const memFree = node.mem - u.mem;
  return `
    <div class="node ${disabled ? 'disabled' : ''}">
      <div class="node-top">
        <span>${esc(node.id)}</span>
        <span>${node.role === 'standby' ? '<span class="badge violet">备用</span>' : node.replace ? '<span class="badge orange">替换中</span>' : '<span class="badge">常规</span>'}</span>
      </div>
      ${node.note ? `<div class="node-note">${esc(node.note)}${node.durationFactor ? ` · 速度×${node.durationFactor}` : ''}</div>` : node.durationFactor ? `<div class="node-note">迁移时长系数 ×${node.durationFactor}</div>` : ''}
      ${capBar(u.cpu, node.cpu)}
      <div class="cap-line"><span>CPU ${u.cpu}/${node.cpu}</span><span>空闲 ${cpuFree}</span></div>
      ${capBar(u.mem, node.mem)}
      <div class="cap-line"><span>内存 ${u.mem}/${node.mem}</span><span>空闲 ${memFree}</span></div>
      <div class="node-note" style="margin-top:6px">实例：${instancesHere.length ? esc(instancesHere.map((i) => i.id).join(', ')) : '无'}</div>
      ${
        node.role === 'standby'
          ? `<button class="btn small ${disabled ? 'good' : 'danger'}" type="button" data-action="toggle-node" data-id="${esc(node.id)}">
              ${disabled ? '恢复可用' : '临时标记不可用'}
            </button>`
          : ''
      }
    </div>`;
}

function renderDrillButton() {
  const btn = $('#drill-button');
  if (scenario.id === capacityBlockScenario.id) {
    btn.textContent = '一键演练：执行 tiny-1，再停用 sb-heavy';
    btn.dataset.action = 'drill-capacity';
    btn.style.display = '';
  } else if (scenario.id === rackBlockScenario.id) {
    btn.textContent = '一键演练：停用 sb-a 并诊断机架约束';
    btn.dataset.action = 'drill-rack';
    btn.style.display = '';
  } else if (scenario.id === tradeoffScenario.id) {
    btn.textContent = '演练扰动：停用 sb-c 后只重排未执行动作';
    btn.dataset.action = 'drill-tradeoff';
    btn.style.display = '';
  } else {
    btn.style.display = 'none';
  }
}

function miniSequence(rt) {
  const p = rt.plan?.selected;
  if (!p) return `<div class="empty">${esc(rt.plan?.diagnosis?.primary?.message ?? '无可行序列')}</div>`;
  return `<ol class="mini-seq">${p.steps
    .map(
      (s, i) => `<li><span class="time">[${s.start},${s.end})</span><span>${i + 1}. ${
        s.kind === 'finalize' ? `收尾 ${s.nodeId}` : `${s.instanceId} → ${s.to}${s.crossRack ? '（跨机架）' : ''}`
      }${s.waitSlots ? ` · 等${s.waitSlots}` : ''}</span></li>`,
    )
    .join('')}</ol>`;
}

function renderCompare() {
  const grid = $('#compare-grid');
  const [strictRt, relaxedRt] = compareRuntimes;
  const strict = strictRt.plan?.selected;
  const relaxed = relaxedRt.plan?.selected;
  let conclusion = '';
  if (strict && relaxed) {
    const diff = compareSelectedPlans(strictRt.scenario, strictRt, strict, relaxed);
    const fd = diff.firstDifference;
    conclusion = `
      <div class="compare-diff full" style="grid-column:1/-1">
        <strong>结论：</strong>
        甲组必须先迁 core-b 去 A 机架补冗余，core-a 到 [2,5) 窗口起点时还不能执行，只能等到 5 槽，完工 ${strict.completionAt} 槽、跨机架 ${strict.crossRack} 次；
        乙组把 minRacks 放宽到 1 后，core-a 可在 [0,2) 先执行并恰好避开窗口，完工 ${relaxed.completionAt} 槽、跨机架 ${relaxed.crossRack} 次。
        ${fd ? `首个分歧在第 ${fd.index + 1} 个动作。` : ''}
        在任一对照卡片切换“最快/最少跨机架”，可观察目标函数改变后的代表序列。
      </div>`;
  }
  grid.innerHTML = `
    ${conclusion}
    ${renderCompareCol(0, strictRt, '甲组约束')}
    ${renderCompareCol(1, relaxedRt, '乙组约束')}
  `;
}

function renderCompareCol(index, rt, label) {
  const p = rt.plan?.selected;
  const rationale = analyzeOrderConstraints(rt.scenario, rt, p).slice(0, 3);
  return `
    <article class="compare-col">
      <div class="card-head">
        <div>
          <span class="badge ${index === 0 ? 'violet' : 'blue'}">${label}</span>
          <h3 style="margin-top:8px">${esc(rt.scenario.title)}</h3>
        </div>
      </div>
      <p class="card-description">${esc(rt.scenario.description)}</p>
      <div class="segmented" role="group" aria-label="${label}目标">
        ${['fastest', 'balanced', 'low-cross']
          .map(
            (o) =>
              `<button class="btn small" type="button" data-action="compare-objective" data-index="${index}" data-objective="${o}" aria-pressed="${rt.objective === o}">${objectiveLabel(o)}</button>`,
          )
          .join('')}
      </div>
      <div class="plan-meta">
        ${p ? `<span class="badge blue">完工 ${p.completionAt}</span><span class="badge orange">跨机架 ${p.crossRack}</span><span class="badge warning">等待 ${p.waitSlots}</span>` : '<span class="badge critical">不可行</span>'}
      </div>
      ${miniSequence(rt)}
      <ul class="rationale">${rationale
        .map((b) => `<li><span class="tag ${esc(b.type)}">${esc(b.type === 'window' ? '窗口' : b.type === 'rack-order' ? '机架' : '说明')}</span><span>${esc(b.text)}</span></li>`)
        .join('')}</ul>
    </article>`;
}

function renderObjectiveDiff() {
  const el = $('#objective-diff');
  if (!el) return;
  const fastRt = createInitialRuntime(scenario, 'fastest');
  const crossRt = createInitialRuntime(scenario, 'low-cross');
  const fast = fastRt.plan?.selected;
  const cross = crossRt.plan?.selected;

  let banner = '';
  if (!fast || !cross) {
    banner = `<div class="compare-diff full" style="grid-column:1/-1">当前场景初始状态无可行序列，请先查看上方约束诊断。</div>`;
  } else if (fast.signature === cross.signature && fast.completionAt === cross.completionAt && fast.crossRack === cross.crossRack) {
    banner = `<div class="compare-diff full" style="grid-column:1/-1"><strong>两个目标选择了同一序列。</strong>该场景中没有“更快但跨机架更多”的有效冲突；可切换到内置“多目标取舍”练习组观察差异。</div>`;
  } else {
    const diff = compareSelectedPlans(scenario, fastRt, fast, cross);
    const fd = diff.firstDifference;
    const fastWhy = analyzeOrderConstraints(scenario, fastRt, fast).find((b) => b.type === 'window' || b.type === 'rack-order');
    const crossWhy = analyzeOrderConstraints(scenario, crossRt, cross).find((b) => b.type === 'window' || b.type === 'rack-order');
    banner = `
      <div class="compare-diff full" style="grid-column:1/-1">
        <strong>目标切换导致的取舍：</strong>
        最快方案 ${fast.completionAt} 槽 / ${fast.crossRack} 次跨机架；最少跨机架方案 ${cross.completionAt} 槽 / ${cross.crossRack} 次。
        用 ${cross.completionAt - fast.completionAt} 个额外槽位换取 ${fast.crossRack - cross.crossRack} 次额外跨机架的避免。
        ${fd ? `首个分歧在第 ${fd.index + 1} 个动作：${fd.a?.instanceId ?? fd.a?.nodeId ?? '?'}→${fd.a?.to ?? '收尾'} 与 ${fd.b?.instanceId ?? fd.b?.nodeId ?? '?'}→${fd.b?.to ?? '收尾'}。` : ''}
        ${fastWhy ? `<br>最快序列：${esc(fastWhy.text)}` : ''}
        ${crossWhy && crossWhy.text !== fastWhy?.text ? `<br>低跨机架序列：${esc(crossWhy.text)}` : ''}
      </div>`;
  }

  el.innerHTML = `
    ${banner}
    ${renderReadOnlyPlanColumn('目标：最快完工', fastRt, 'blue')}
    ${renderReadOnlyPlanColumn('目标：最少跨机架', crossRt, 'orange')}
  `;
}

function renderReadOnlyPlanColumn(title, rt, tone) {
  const p = rt.plan?.selected;
  const rationale = analyzeOrderConstraints(rt.scenario, rt, p).slice(0, 4);
  return `
    <article class="compare-col">
      <span class="badge ${tone}">${esc(title)}</span>
      <div class="plan-meta" style="margin-top:10px">
        ${p ? `<span class="badge blue">完工 ${p.completionAt}</span><span class="badge orange">跨机架 ${p.crossRack}</span><span class="badge warning">等待 ${p.waitSlots}</span>` : '<span class="badge critical">不可行</span>'}
      </div>
      ${miniSequence(rt)}
      <ul class="rationale">${rationale
        .map((b) => `<li><span class="tag ${esc(b.type)}">${esc(b.type === 'window' ? '窗口' : b.type === 'rack-order' ? '机架' : b.type === 'cross' ? '跨机架' : '说明')}</span><span>${esc(b.text)}</span></li>`)
        .join('')}</ul>
    </article>`;
}

function renderAll() {
  renderPresets();
  renderMetrics();
  renderBlocker();
  renderPareto();
  renderGantt();
  renderStepList();
  renderRationale();
  renderRuntimeTopology();
  renderDrillButton();
  renderCompare();
  renderObjectiveDiff();
}

// ---------- 事件 ----------
document.addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;

  if (action === 'load-preset') {
    const p = presets.find((x) => x.id === btn.dataset.id);
    if (p) loadScenario(p);
    return;
  }

  if (action === 'select-plan') {
    const index = Number(btn.dataset.index);
    const p = runtime.plan?.plans?.[index];
    if (p) {
      runtime.plan.selected = p;
      renderPareto();
      renderGantt();
      renderStepList();
      renderRationale();
    }
    return;
  }

  if (action === 'toggle-node') {
    const id = btn.dataset.id;
    const willDisable = !runtime.disabledNodes.includes(id);
    const usedByExecuted = runtime.executed.some((s) => s.kind === 'migrate' && s.to === id);
    const res = setNodeAvailability(runtime, id, willDisable);
    if (!res.ok) toast(res.error);
    else {
      toast(willDisable ? `已停用 ${id}，未执行动作已重排；已执行前缀保留。` : `已恢复 ${id}，并重新规划未执行动作。`);
      if (willDisable && usedByExecuted) toast(`注意：${id} 上已有执行过的迁移；按“停止接纳新调度”处理，不回滚已执行动作。`);
    }
    renderAll();
    return;
  }

  if (action === 'drill-capacity') {
    let res = executeCandidate(runtime, 'tiny-1', 'sb-a');
    if (!res.ok) {
      toast('无法先执行 tiny-1：' + (res.reasons?.[0]?.message ?? res.error));
      return;
    }
    setNodeAvailability(runtime, 'sb-heavy', true);
    toast('已执行 tiny-1，并停用 sb-heavy；big-1 被容量约束卡住。');
    renderAll();
    return;
  }

  if (action === 'drill-rack') {
    setNodeAvailability(runtime, 'sb-a', true);
    toast('已停用 sb-a；搜索会保留安全前缀并定位机架冗余阻塞。');
    renderAll();
    return;
  }

  if (action === 'drill-tradeoff') {
    if (!runtime.disabledNodes.includes('sb-c')) setNodeAvailability(runtime, 'sb-c', true);
    else setNodeAvailability(runtime, 'sb-c', false);
    renderAll();
    return;
  }

  if (action === 'compare-objective') {
    const idx = Number(btn.dataset.index);
    setObjective(compareRuntimes[idx], btn.dataset.objective);
    renderCompare();
  }
});

$$('[data-objective]').forEach((btn) => {
  btn.addEventListener('click', () => {
    setObjective(runtime, btn.dataset.objective);
    renderMetrics();
    renderBlocker();
    renderPareto();
    renderGantt();
    renderStepList();
    renderRationale();
  });
});

$('#execute-next').addEventListener('click', () => {
  const res = executeNext(runtime);
  if (!res.ok) {
    toast(res.error);
    renderBlocker();
    return;
  }
  toast(`已执行 ${res.executedStep.id}，并基于新状态重排剩余动作。`);
  renderAll();
});

$('#reset-runtime').addEventListener('click', () => {
  runtime = createInitialRuntime(scenario, runtime.objective);
  toast('执行状态已重置。');
  renderAll();
});

$('#apply-json').addEventListener('click', () => {
  try {
    const parsed = JSON.parse($('#scenario-json').value);
    const errors = validateScenario(parsed);
    renderValidation(errors);
    if (errors.length) {
      toast('JSON 已解析，但场景校验未通过。');
      return;
    }
    loadScenario(parsed, runtime.objective);
    toast('已载入自定义场景并完成规划。');
  } catch (err) {
    renderValidation([`JSON 解析失败：${err.message}`]);
    toast('JSON 解析失败。');
  }
});

$('#format-json').addEventListener('click', () => {
  try {
    $('#scenario-json').value = JSON.stringify(JSON.parse($('#scenario-json').value), null, 2);
    toast('JSON 已格式化。');
  } catch (err) {
    toast(`无法格式化：${err.message}`);
  }
});

$('#theme-toggle').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme !== 'dark';
  root.dataset.theme = dark ? 'dark' : 'light';
  localStorage.setItem('bench-theme', dark ? 'dark' : 'light');
  $('#theme-toggle').setAttribute('aria-pressed', String(dark));
  $('#theme-toggle').textContent = dark ? '☀️ 浅色' : '🌙 深色';
});

(function initTheme() {
  const saved = localStorage.getItem('bench-theme');
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const dark = saved ? saved === 'dark' : prefersDark;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const btn = $('#theme-toggle');
  btn.setAttribute('aria-pressed', String(dark));
  btn.textContent = dark ? '☀️ 浅色' : '🌙 深色';
})();

$('#scenario-json').value = JSON.stringify(scenario, null, 2);
renderAll();
