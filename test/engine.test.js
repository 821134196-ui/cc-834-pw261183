import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateScenario,
  createInitialRuntime,
  setObjective,
  setNodeAvailability,
  executeCandidate,
  executeNext,
} from '../js/engine.js';
import {
  tradeoffScenario,
  capacityBlockScenario,
  rackBlockScenario,
  strictComparisonScenario,
  relaxedComparisonScenario,
} from '../js/examples.js';

test('all built-in scenarios validate', () => {
  for (const scenario of [
    tradeoffScenario,
    capacityBlockScenario,
    rackBlockScenario,
    strictComparisonScenario,
    relaxedComparisonScenario,
  ]) {
    assert.deepEqual(validateScenario(scenario), [], `${scenario.id} should be valid`);
  }
});

test('tradeoff scenario exposes fastest and least-cross safe Pareto plans', () => {
  const fastest = createInitialRuntime(tradeoffScenario, 'fastest');
  assert.equal(fastest.plan.feasible, true);
  assert.ok(fastest.plan.plans.length >= 2);

  const fast = fastest.plan.selected;
  const lowRuntime = createInitialRuntime(tradeoffScenario, 'low-cross');
  const low = lowRuntime.plan.selected;

  assert.equal(fast.completionAt, Math.min(...fastest.plan.plans.map((p) => p.completionAt)));
  assert.equal(low.crossRack, Math.min(...lowRuntime.plan.plans.map((p) => p.crossRack)));
  assert.ok(low.crossRack < fast.crossRack, 'least-cross plan should cross fewer racks');
  assert.ok(low.completionAt >= fast.completionAt, 'less crossing should not be magically faster in this sample');

  // 所有返回步骤都必须在 horizon 内且时间区间合法。
  for (const p of fastest.plan.plans) {
    for (const s of p.steps) {
      assert.ok(s.start >= 0 && s.end > s.start);
      assert.ok(s.end <= tradeoffScenario.horizon + 2); // 收尾动作允许贴近 horizon
    }
  }
});

test('capacity drill preserves executed prefix and identifies capacity blocker', () => {
  const rt = createInitialRuntime(capacityBlockScenario, 'fastest');
  assert.equal(rt.plan.feasible, true);

  const executed = executeCandidate(rt, 'tiny-1', 'sb-a');
  assert.equal(executed.ok, true);
  assert.equal(rt.executed.length, 1);
  assert.equal(rt.migrated['tiny-1'], true);

  const result = setNodeAvailability(rt, 'sb-heavy', true);
  assert.equal(result.ok, true);
  assert.equal(rt.plan.feasible, false);
  assert.equal(rt.plan.diagnosis.primary.code, 'CAPACITY');
  assert.match(rt.plan.diagnosis.primary.message, /big-1/);

  // 扰动后不得回滚或重写已执行动作。
  assert.equal(rt.executed.length, 1);
  assert.equal(rt.executed[0].instanceId, 'tiny-1');
  assert.equal(rt.placements['tiny-1'], 'sb-a');
});

test('rack drill identifies rack redundancy blocker after safe prefix', () => {
  const rt = createInitialRuntime(rackBlockScenario, 'balanced');
  assert.equal(rt.plan.feasible, true);
  assert.equal(rt.plan.selected.crossRack, 1);

  setNodeAvailability(rt, 'sb-a', true);
  assert.equal(rt.plan.feasible, false);
  assert.equal(rt.plan.diagnosis.primary.code, 'RACK_REDUNDANCY');
  assert.match(rt.plan.diagnosis.primary.message, /minRacks|机架/);
});

test('replan after disruption changes only pending actions', () => {
  const rt = createInitialRuntime(tradeoffScenario, 'low-cross');
  const first = rt.plan.selected.steps.find((s) => s.kind === 'migrate');
  const res = executeNext(rt);
  assert.equal(res.ok, true);
  assert.equal(rt.executed.length, 1);

  // 停用同机架 A 的 sb-a，迫使原低跨机架方案的后续动作改走其他目标。
  setNodeAvailability(rt, 'sb-a', true);
  assert.equal(rt.plan.feasible, true);
  assert.ok(rt.plan.selected, 'should find a rearranged pending plan');
  assert.equal(rt.executed.length, 1, 'executed prefix must remain fixed');
  assert.equal(rt.executed[0].id, first.id);
  for (const s of rt.plan.selected.steps) {
    if (s.kind === 'migrate') assert.notEqual(s.to, 'sb-a');
  }
});

test('eviction window creates explicit wait in strict comparison group', () => {
  const rt = createInitialRuntime(strictComparisonScenario, 'fastest');
  assert.equal(rt.plan.feasible, true);
  const [first, second] = rt.plan.selected.steps.filter((s) => s.kind === 'migrate');
  assert.equal(first.instanceId, 'core-b');
  assert.equal(second.instanceId, 'core-a');
  assert.equal(second.start, 5);
  assert.equal(second.waitSlots, 3);
  assert.equal(rt.plan.selected.completionAt, 9);
});

test('relaxed rack constraint reverses first two actions and avoids wait', () => {
  const rt = createInitialRuntime(relaxedComparisonScenario, 'fastest');
  assert.equal(rt.plan.feasible, true);
  const [first, second] = rt.plan.selected.steps.filter((s) => s.kind === 'migrate');
  assert.equal(first.instanceId, 'core-a');
  assert.equal(second.instanceId, 'core-b');
  assert.equal(first.waitSlots, 0);
  assert.equal(rt.plan.selected.completionAt, 6);
  assert.equal(rt.plan.selected.crossRack, 0);
});

test('objective switch changes selected plan on tradeoff front', () => {
  const rt = createInitialRuntime(tradeoffScenario, 'fastest');
  const fastCompletion = rt.plan.selected.completionAt;
  setObjective(rt, 'low-cross');
  const lowCross = rt.plan.selected.crossRack;
  assert.ok(lowCross < rt.plan.plans.find((p) => p.completionAt === fastCompletion)?.crossRack + 1);
  assert.equal(rt.plan.selected.crossRack, Math.min(...rt.plan.plans.map((p) => p.crossRack)));
});
