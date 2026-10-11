// 몬테카를로 반복 실행 (Web Worker). 반복마다 시드를 바꿔 기준/정책 쌍을 실행.
import { runPair } from './engine.js';
import { meanCI } from './stats.js';

self.onmessage = (e) => {
  const { districts, params, basePolicy, policy, reps, days, scale, seed, projection } = e.data;
  // postMessage는 Set을 배열로 보내므로 복원
  for (const p of [policy, basePolicy]) if (p.targets) p.targets = new Set(p.targets);
  const runs = [];
  for (let r = 0; r < reps; r++) {
    runs.push(runPair(districts, params, basePolicy, policy, { seed: seed + r * 7919, scale, days, years: Math.ceil(days / 365), projection }));
    self.postMessage({ type: 'progress', done: r + 1, reps });
  }
  const keys = Object.keys(runs[0].base);
  const out = {};
  for (const k of keys) {
    out[k] = {
      base: meanCI(runs.map((x) => x.base[k])),
      policy: meanCI(runs.map((x) => x.policy[k])),
      // 대응표본 차이(정책 - 기준): 공통난수 덕분에 분산이 작아짐
      diff: meanCI(runs.map((x) => x.policy[k] - x.base[k])),
    };
  }
  self.postMessage({ type: 'done', result: out, reps, days, scale });
};
