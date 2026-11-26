import {
  createInitialRuntime,
  planFromRuntime,
  setNodeAvailability,
  executeNext,
  totalMetrics,
  analyzeOrderConstraints,
} from '../js/engine.js';
import { presets, strictComparisonScenario, relaxedComparisonScenario } from '../js/examples.js';

function printPlan(runtime, title = '') {
  const plan = runtime.plan;
  console.log(`\n=== ${title || runtime.scenario.title} ===`);
  if (!plan.feasible) {
    console.log('无可行计划:', plan.diagnosis?.primary?.constraint, '-', plan.diagnosis?.primary?.message);
    return;
  }
  const m = totalMetrics(runtime, plan.selected);
  console.log(
    `目标=${runtime.objective} 完工=${m.completionAt} 跨机架=${m.crossRack} 等待=${plan.selected.waitSlots} ` +
      `Pareto数=${plan.plans.length} 解数=${plan.allSolutionCount}`,
  );
  for (const s of plan.selected.steps) {
    if (s.kind === 'migrate') {
      console.log(
        `  [${String(s.start).padStart(2)},${String(s.end).padStart(2)}) ` +
          `${s.instanceId.padEnd(13)} ${s.from}->${s.to} ` +
          `${s.rackFrom}->${s.rackTo}${s.crossRack ? ' 跨机架' : ''} ` +
          `dur=${s.duration} wait=${s.waitSlots}`,
      );
    } else {
      console.log(`  [${String(s.start).padStart(2)},${String(s.end).padStart(2)}) finalize ${s.nodeId}`);
    }
  }
  const why = analyzeOrderConstraints(runtime.scenario, runtime, plan.selected);
  for (const b of why.slice(0, 8)) console.log(`  解释: ${b.text}`);
  if (plan.plans.length > 1) {
    console.log('Pareto 前沿:');
    for (const p of plan.plans) {
      console.log(`  completion=${p.completionAt} cross=${p.crossRack} wait=${p.waitSlots} sig=${p.signature}`);
    }
  }
}

for (const preset of presets.slice(0, 3)) {
  const rt = createInitialRuntime(preset, 'balanced');
  printPlan(rt);
  const fast = createInitialRuntime(preset, 'fastest');
  printPlan(fast, `${preset.title} / fastest`);
  const low = createInitialRuntime(preset, 'low-cross');
  printPlan(low, `${preset.title} / low-cross`);
}

console.log('\n\n########## 扰动：capacity-block 执行 tiny-1 后停用 sb-heavy ##########');
{
  const rt = createInitialRuntime(presets[1], 'balanced');
  executeNext(rt);
  console.log('已执行:', rt.executed.map((s) => s.id).join(', '), 'clock=', rt.clock);
  const res = setNodeAvailability(rt, 'sb-heavy', true);
  if (!res.plan.feasible) {
    console.log('阻塞约束:', res.plan.diagnosis.primary.constraint);
    console.log(res.plan.diagnosis.primary.message);
    console.log('保留已执行:', res.plan ? rt.executed.map((s) => s.id) : []);
  }
}

console.log('\n\n########## 扰动：rack-block 直接停用 sb-a ##########');
{
  const rt = createInitialRuntime(presets[2], 'balanced');
  setNodeAvailability(rt, 'sb-a', true);
  if (!rt.plan.feasible) {
    console.log('阻塞约束:', rt.plan.diagnosis.primary.constraint);
    console.log(rt.plan.diagnosis.primary.message);
    if (rt.plan.diagnosis.primary.afterSteps?.length) {
      console.log('最深死路前缀:', rt.plan.diagnosis.primary.afterSteps.join(' -> '));
    }
  }
}

console.log('\n\n########## 两组约束对照 ##########');
for (const sc of [strictComparisonScenario, relaxedComparisonScenario]) {
  const rt = createInitialRuntime(sc, 'fastest');
  printPlan(rt);
}
