#!/usr/bin/env node
/**
 * MeetingFlow mini eval runner.
 *
 * 用 golden-set.json 跑 verify-evidence -> stable-id -> retrieve -> score-run，
 * 输出 precision / recall / F1 / dedupe / retrieval@k 指标。
 *
 * Usage:
 *   node skills/meetingflow-core/eval/run-eval.mjs
 *   node skills/meetingflow-core/eval/run-eval.mjs --golden=path/to/golden-set.json
 *   node skills/meetingflow-core/eval/run-eval.mjs --json   # 只输出 JSON 报告
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CORE_PATH = path.join(ROOT, 'skills', 'meetingflow-core', 'scripts', 'core.mjs');
const DEFAULT_GOLDEN = path.join(__dirname, 'golden-set.json');

const args = parseArgs(process.argv.slice(2));
const goldenPath = args.golden || DEFAULT_GOLDEN;
const jsonOnly = !!args.json;

const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
const report = {
  golden_path: path.relative(ROOT, goldenPath),
  total_cases: golden.cases.length,
  evidence: { tp: 0, fp: 0, fn: 0, tn: 0 },
  stable_id: { dedupe_expected: 0, dedupe_actual: 0 },
  retrieval: { total: 0, hit_at_1: 0, hit_at_k: 0, must_not_top_violations: 0 },
  cases: [],
};

for (const c of golden.cases) {
  const caseReport = { case_id: c.case_id, scenario: c.scenario, checks: [] };

  if (Array.isArray(c.candidate_items) && c.candidate_items.length > 0) {
    const verifyOut = runCore('verify-evidence', {
      sources: c.sources,
      items: c.candidate_items,
    });
    const expectedSet = new Set((c.expected?.verified_evidence_sentences || []).map(normalize));
    const rejectedSet = new Set((c.expected?.rejected_evidence_sentences || []).map(normalize));

    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const item of verifyOut.items) {
      const norm = normalize(item.evidence_sentence);
      const shouldPass = expectedSet.has(norm);
      const shouldFail = rejectedSet.has(norm);
      if (item.verified === true && shouldPass) tp += 1;
      else if (item.verified === true && shouldFail) fp += 1;
      else if (item.verified === false && shouldPass) fn += 1;
      else if (item.verified === false && shouldFail) tn += 1;
    }
    report.evidence.tp += tp;
    report.evidence.fp += fp;
    report.evidence.fn += fn;
    report.evidence.tn += tn;
    caseReport.checks.push({
      type: 'verify-evidence',
      tp, fp, fn, tn,
      verified_count: verifyOut.verified_count,
      rejected_count: verifyOut.rejected_count,
      expected_verified: c.expected?.verified_count ?? null,
      expected_rejected: c.expected?.rejected_count ?? null,
    });

    // stable-id pass on verified items
    const verifiedItems = verifyOut.items.filter((item) => item.verified === true);
    if (verifiedItems.length > 0) {
      const idOut = runCore('stable-id', { namespace: 'eval', items: verifiedItems });
      const fingerprints = idOut.items.map(
        (item) => item.action_fingerprint || item.claim_fingerprint || null,
      );
      const uniqueFps = new Set(fingerprints.filter(Boolean));
      const dedupeCollapsed = fingerprints.length - uniqueFps.size;

      if (c.expected?.expect_dedupe_by_fingerprint) {
        report.stable_id.dedupe_expected += 1;
        if (dedupeCollapsed > 0) report.stable_id.dedupe_actual += 1;
      }
      caseReport.checks.push({
        type: 'stable-id',
        verified_in: verifiedItems.length,
        unique_fingerprints: uniqueFps.size,
        dedupe_collapsed: dedupeCollapsed,
        expected_dedupe: !!c.expected?.expect_dedupe_by_fingerprint,
      });

      // score-run on the same set
      const scoreOut = runCore('score-run', {
        items: idOut.items,
        metrics: { failed_run_count: 0, total_run_count: 1, on_time_run_count: 1, expected_run_count: 1 },
      });
      caseReport.checks.push({
        type: 'score-run',
        overall_score_100: scoreOut.overall_score_100,
        dimensions: scoreOut.dimensions,
      });
    }
  }

  if (c.retrieval) {
    report.retrieval.total += 1;
    const out = runCore('retrieve', {
      query: c.retrieval.query,
      top_k: c.retrieval.top_k,
      docs: c.retrieval.docs,
    });
    const topIds = out.hits.map((h) => h.doc_id);
    const expected = c.retrieval.expected_top_doc_ids || [];
    const mustNot = c.retrieval.must_not_top || [];
    const hit1 = expected.length > 0 && topIds[0] === expected[0];
    const hitK = expected.every((id) => topIds.includes(id));
    const violation = mustNot.some((id) => topIds[0] === id);
    if (hit1) report.retrieval.hit_at_1 += 1;
    if (hitK) report.retrieval.hit_at_k += 1;
    if (violation) report.retrieval.must_not_top_violations += 1;
    caseReport.checks.push({
      type: 'retrieve',
      top_ids: topIds,
      expected_top_doc_ids: expected,
      must_not_top: mustNot,
      hit_at_1: hit1,
      hit_at_k: hitK,
      must_not_top_violation: violation,
    });
  }

  report.cases.push(caseReport);
}

const e = report.evidence;
const precision = safeRatio(e.tp, e.tp + e.fp);
const recall = safeRatio(e.tp, e.tp + e.fn);
const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
report.metrics = {
  evidence_precision: round4(precision),
  evidence_recall: round4(recall),
  evidence_f1: round4(f1),
  retrieval_hit_at_1: report.retrieval.total ? round4(report.retrieval.hit_at_1 / report.retrieval.total) : null,
  retrieval_hit_at_k: report.retrieval.total ? round4(report.retrieval.hit_at_k / report.retrieval.total) : null,
  retrieval_must_not_top_violations: report.retrieval.must_not_top_violations,
  stable_id_dedupe_pass: report.stable_id.dedupe_expected === 0
    ? null
    : round4(report.stable_id.dedupe_actual / report.stable_id.dedupe_expected),
};

if (jsonOnly) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  printHumanReport(report);
}

const m = report.metrics;
const passed = (m.evidence_precision >= 0.99) &&
  (m.evidence_recall >= 0.99) &&
  (m.retrieval_hit_at_1 === null || m.retrieval_hit_at_1 >= 0.99) &&
  (m.retrieval_must_not_top_violations === 0) &&
  (m.stable_id_dedupe_pass === null || m.stable_id_dedupe_pass >= 0.99);
process.exitCode = passed ? 0 : 1;

function runCore(cmd, payload) {
  const result = spawnSync('node', [CORE_PATH, cmd], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  if (result.status !== 0 && result.status !== null) {
    throw new Error(`core ${cmd} exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`core ${cmd} returned invalid JSON: ${result.stdout}`);
  }
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (arg === '--json') out.json = true;
    else if (arg.startsWith('--golden=')) out.golden = arg.slice('--golden='.length);
  }
  return out;
}

function normalize(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

function safeRatio(num, den) {
  if (!den) return 0;
  return num / den;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function printHumanReport(r) {
  const m = r.metrics;
  console.log('MeetingFlow Mini Eval');
  console.log('---------------------');
  console.log(`Golden: ${r.golden_path}`);
  console.log(`Cases:  ${r.total_cases}`);
  console.log('');
  console.log('Evidence verification');
  console.log(`  TP=${r.evidence.tp}  FP=${r.evidence.fp}  FN=${r.evidence.fn}  TN=${r.evidence.tn}`);
  console.log(`  precision=${m.evidence_precision}  recall=${m.evidence_recall}  f1=${m.evidence_f1}`);
  console.log('');
  if (r.retrieval.total > 0) {
    console.log('Retrieval');
    console.log(`  cases=${r.retrieval.total}  hit@1=${m.retrieval_hit_at_1}  hit@k=${m.retrieval_hit_at_k}`);
    console.log(`  must_not_top_violations=${m.retrieval_must_not_top_violations}`);
    console.log('');
  }
  if (r.stable_id.dedupe_expected > 0) {
    console.log('Stable-ID dedupe');
    console.log(`  expected_cases=${r.stable_id.dedupe_expected}  pass_rate=${m.stable_id_dedupe_pass}`);
    console.log('');
  }
  console.log('Per case');
  for (const c of r.cases) {
    console.log(`  - ${c.case_id} (${c.scenario})`);
    for (const check of c.checks) {
      console.log(`      ${check.type}: ${formatCheck(check)}`);
    }
  }
}

function formatCheck(check) {
  switch (check.type) {
    case 'verify-evidence':
      return `verified=${check.verified_count}/${check.expected_verified} rejected=${check.rejected_count}/${check.expected_rejected}`;
    case 'stable-id':
      return `unique_fp=${check.unique_fingerprints} dedupe_collapsed=${check.dedupe_collapsed} expected_dedupe=${check.expected_dedupe}`;
    case 'score-run':
      return `overall_100=${check.overall_score_100}`;
    case 'retrieve':
      return `top=[${check.top_ids.join(',')}] hit@1=${check.hit_at_1} hit@k=${check.hit_at_k}`;
    default:
      return JSON.stringify(check);
  }
}
