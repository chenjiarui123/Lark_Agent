#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const COMMANDS = new Set([
  'verify-evidence',
  'stable-id',
  'score-run',
  'retrieve',
  'checkpoint-get',
  'checkpoint-set',
  'lock-acquire',
  'lock-release',
]);

const command = process.argv[2];

main().catch((error) => {
  writeJson({
    ok: false,
    command: command || null,
    error: error?.message || String(error),
  });
  process.exitCode = 1;
});

async function main() {
  if (!command || !COMMANDS.has(command)) {
    writeJson({
      ok: false,
      error: `Unknown command: ${command || '(missing)'}`,
      supported_commands: [...COMMANDS],
    });
    process.exitCode = 2;
    return;
  }

  const input = await readStdinJson();
  const result = runCommand(command, input);
  writeJson(result);
}

function runCommand(name, input) {
  switch (name) {
    case 'verify-evidence':
      return verifyEvidence(input);
    case 'stable-id':
      return stableId(input);
    case 'score-run':
      return scoreRun(input);
    case 'retrieve':
      return retrieve(input);
    case 'checkpoint-get':
      return checkpointGet(input);
    case 'checkpoint-set':
      return checkpointSet(input);
    case 'lock-acquire':
      return lockAcquire(input);
    case 'lock-release':
      return lockRelease(input);
    default:
      throw new Error(`Unsupported command: ${name}`);
  }
}

async function readStdinJson() {
  const raw = await new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });

  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Invalid JSON stdin: ${error.message}`);
  }
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function verifyEvidence(input) {
  const sources = collectSources(input);
  const items = Array.isArray(input.items) ? input.items : [];
  if (items.length === 0) {
    return {
      ok: false,
      command,
      error: 'items must be a non-empty array',
    };
  }
  if (sources.length === 0) {
    return {
      ok: false,
      command,
      error: 'source_text or sources[].text is required',
    };
  }

  const verifiedItems = items.map((item, index) => {
    const evidence = stringValue(item.evidence_sentence);
    if (!evidence) {
      return markRejected(item, index, 'missing_evidence_sentence');
    }

    const match = findEvidenceMatch(evidence, sources);
    if (!match) {
      return markRejected(item, index, 'evidence_not_found');
    }

    return {
      ...item,
      verified: true,
      verification_status: 'verified',
      evidence_hash: sha256Short(normalizeForHash(evidence), 16),
      evidence_source_id: match.source.source_id,
      evidence_source_title: match.source.title || null,
      evidence_source_url: match.source.url || null,
      evidence_match_type: match.match_type,
      evidence_match_index: match.index,
      evidence_normalized_length: normalizeLoose(evidence).length,
    };
  });

  const verifiedCount = verifiedItems.filter((item) => item.verified === true).length;
  return {
    ok: true,
    command,
    total: verifiedItems.length,
    verified_count: verifiedCount,
    rejected_count: verifiedItems.length - verifiedCount,
    items: verifiedItems,
  };
}

function collectSources(input) {
  const sources = [];
  if (typeof input.source_text === 'string' && input.source_text.trim()) {
    sources.push({
      source_id: input.source_id || 'source_text',
      title: input.source_title || null,
      url: input.source_url || null,
      text: input.source_text,
    });
  }
  if (Array.isArray(input.sources)) {
    for (const [index, source] of input.sources.entries()) {
      if (typeof source?.text === 'string' && source.text.trim()) {
        sources.push({
          source_id: source.source_id || source.id || `source_${index + 1}`,
          title: source.title || source.source_title || null,
          url: source.url || source.source_url || null,
          text: source.text,
        });
      }
    }
  }
  return sources;
}

function findEvidenceMatch(evidence, sources) {
  const rawNeedle = evidence.trim();
  const looseNeedle = normalizeLoose(rawNeedle);
  const compactNeedle = normalizeCompact(rawNeedle);

  for (const source of sources) {
    const text = source.text || '';
    const rawIndex = text.indexOf(rawNeedle);
    if (rawIndex >= 0) {
      return { source, match_type: 'exact', index: rawIndex };
    }
  }

  for (const source of sources) {
    const looseText = normalizeLoose(source.text || '');
    const looseIndex = looseText.indexOf(looseNeedle);
    if (looseNeedle.length >= 6 && looseIndex >= 0) {
      return { source, match_type: 'normalized', index: looseIndex };
    }
  }

  for (const source of sources) {
    const compactText = normalizeCompact(source.text || '');
    const compactIndex = compactText.indexOf(compactNeedle);
    if (compactNeedle.length >= 10 && compactIndex >= 0) {
      return { source, match_type: 'compact', index: compactIndex };
    }
  }

  return null;
}

function markRejected(item, index, reason) {
  return {
    ...item,
    verified: false,
    verification_status: 'rejected',
    rejection_reason: reason,
    item_index: index,
  };
}

function stableId(input) {
  const namespace = normalizeToken(input.namespace || 'meetingflow');
  const items = Array.isArray(input.items) ? input.items : [];
  if (items.length === 0) {
    return {
      ok: false,
      command,
      error: 'items must be a non-empty array',
    };
  }

  const outputItems = items.map((item) => {
    if (item.verified === false && input.include_rejected !== true) {
      return {
        ...item,
        id_status: 'skipped_rejected',
      };
    }
    const type = normalizeToken(item.type || inferItemType(item));
    if (type === 'action' || type === 'action_item') {
      return withActionId(namespace, item);
    }
    return withClaimId(namespace, item);
  });

  return {
    ok: true,
    command,
    namespace,
    total: outputItems.length,
    items: outputItems,
  };
}

function withClaimId(namespace, item) {
  const claimType = normalizeToken(item.claim_type || 'claim');
  const claimText = normalizeSemantic(item.claim || item.text || item.content || '');
  if (!claimText) {
    return {
      ...item,
      id_status: 'rejected',
      id_error: 'missing_claim',
    };
  }

  const fingerprintInput = `${namespace}|claim|${claimType}|${claimText}`;
  const claimFingerprint = sha256Short(fingerprintInput, 24);
  const evidenceHash = item.evidence_hash || sha256Short(normalizeForHash(item.evidence_sentence || ''), 16);
  const occurrenceInput = [
    namespace,
    'claim-occurrence',
    claimFingerprint,
    normalizeSemantic(item.source_type || ''),
    normalizeSemantic(item.source_title || ''),
    normalizeForHash(item.source_url || ''),
    evidenceHash,
  ].join('|');

  return {
    ...item,
    claim_id: item.claim_id || `claim_${claimFingerprint}`,
    claim_fingerprint: claimFingerprint,
    occurrence_id: item.occurrence_id || `occ_${sha256Short(occurrenceInput, 24)}`,
    id_status: 'stable',
  };
}

function withActionId(namespace, item) {
  const taskText = normalizeSemantic(item.task || item.action || item.action_item || item.content || item.text || '');
  if (!taskText) {
    return {
      ...item,
      id_status: 'rejected',
      id_error: 'missing_task',
    };
  }

  const assignee = normalizeSemantic(item.assignee || item.owner || item.responsible || '');
  const due = normalizeSemantic(item.due_date || item.deadline || '');
  const evidenceHash = item.evidence_hash || sha256Short(normalizeForHash(item.evidence_sentence || ''), 16);
  const actionInput = `${namespace}|action|${taskText}|${assignee}|${due}|${evidenceHash}`;
  const actionFingerprint = sha256Short(actionInput, 24);

  return {
    ...item,
    action_id: item.action_id || `act_${actionFingerprint}`,
    action_fingerprint: actionFingerprint,
    id_status: 'stable',
  };
}

function inferItemType(item) {
  if (item.task || item.action || item.action_item || item.assignee || item.owner || item.deadline) {
    return 'action_item';
  }
  return 'claim';
}

function scoreRun(input) {
  const metrics = inferMetrics(input);

  const dimensions = {
    evidence_groundedness: ratio(metrics.verified_evidence_count, metrics.total_evidence_count, 1),
    action_item_accuracy: ratio(
      metrics.human_correct_action_count ?? metrics.verified_action_count,
      metrics.human_reviewed_action_count ?? metrics.total_action_count,
      1,
    ),
    premeeting_usefulness: ratio(metrics.useful_card_count, metrics.feedback_card_count, 0.5),
    run_stability: clamp01(1 - ratio(metrics.failed_run_count, metrics.total_run_count, 0)),
    timeliness: ratio(metrics.on_time_run_count, metrics.expected_run_count, 1),
    dedupe_quality: clamp01(1 - ratio(metrics.duplicate_item_count, metrics.total_item_count, 0)),
  };

  const weights = {
    evidence_groundedness: 0.25,
    action_item_accuracy: 0.2,
    premeeting_usefulness: 0.15,
    run_stability: 0.15,
    timeliness: 0.1,
    dedupe_quality: 0.15,
  };

  const overall = Object.entries(weights).reduce((sum, [key, weight]) => {
    return sum + dimensions[key] * weight;
  }, 0);

  return {
    ok: true,
    command,
    metrics,
    dimensions,
    weights,
    overall_score: round4(overall),
    overall_score_100: Math.round(overall * 1000) / 10,
  };
}

function inferMetrics(input) {
  const metrics = { ...(input.metrics || {}) };
  const items = Array.isArray(input.items) ? input.items : [];
  const claims = items.filter((item) => inferItemType(item) === 'claim');
  const actions = items.filter((item) => inferItemType(item) !== 'claim');

  if (metrics.total_evidence_count == null && items.length) {
    metrics.total_evidence_count = items.filter((item) => item.evidence_sentence).length;
  }
  if (metrics.verified_evidence_count == null && items.length) {
    metrics.verified_evidence_count = items.filter((item) => item.verified === true).length;
  }
  if (metrics.total_action_count == null && actions.length) {
    metrics.total_action_count = actions.length;
  }
  if (metrics.verified_action_count == null && actions.length) {
    metrics.verified_action_count = actions.filter((item) => item.verified === true).length;
  }
  if (metrics.total_item_count == null && items.length) {
    metrics.total_item_count = items.length;
  }
  if (metrics.duplicate_item_count == null) {
    const ids = new Set();
    let duplicates = 0;
    for (const item of [...claims, ...actions]) {
      const id = item.claim_fingerprint || item.action_fingerprint || item.claim_id || item.action_id;
      if (!id) continue;
      if (ids.has(id)) duplicates += 1;
      ids.add(id);
    }
    metrics.duplicate_item_count = duplicates;
  }

  return normalizeNumberMap(metrics, [
    'verified_evidence_count',
    'total_evidence_count',
    'human_correct_action_count',
    'human_reviewed_action_count',
    'verified_action_count',
    'total_action_count',
    'useful_card_count',
    'feedback_card_count',
    'failed_run_count',
    'total_run_count',
    'on_time_run_count',
    'expected_run_count',
    'duplicate_item_count',
    'total_item_count',
  ]);
}

function normalizeNumberMap(metrics, keys) {
  const out = { ...metrics };
  for (const key of keys) {
    if (out[key] == null || out[key] === '') continue;
    const value = Number(out[key]);
    out[key] = Number.isFinite(value) ? value : 0;
  }
  return out;
}

function checkpointGet(input) {
  const job = requireKey(input, 'job');
  const store = readJsonFile(checkpointPath(), {});
  const checkpoint = store[job] || null;
  return {
    ok: true,
    command,
    job,
    checkpoint,
    cursor: checkpoint?.cursor ?? null,
  };
}

function retrieve(input) {
  const query = stringValue(input.query);
  if (!query) {
    return { ok: false, command, error: 'query is required' };
  }
  const docs = Array.isArray(input.docs) ? input.docs : [];
  if (docs.length === 0) {
    return { ok: false, command, error: 'docs must be a non-empty array' };
  }
  const topK = clampNumber(Number(input.top_k ?? 5), 1, 50);
  const minScore = Number.isFinite(Number(input.min_score)) ? Number(input.min_score) : 0;
  const k1 = 1.5;
  const b = 0.75;

  const normalizedDocs = docs.map((doc, index) => {
    const text = stringValue(doc.text);
    const tokens = tokenize(text);
    return {
      doc_id: stringValue(doc.doc_id) || stringValue(doc.id) || `doc_${index + 1}`,
      title: stringValue(doc.title) || null,
      url: stringValue(doc.url) || null,
      source_type: stringValue(doc.source_type) || null,
      text,
      tokens,
      length: tokens.length,
      tf: termFrequency(tokens),
    };
  });

  const totalDocs = normalizedDocs.length;
  const avgDocLen = normalizedDocs.reduce((sum, d) => sum + d.length, 0) / Math.max(totalDocs, 1);
  const queryTokens = uniqueTokens(tokenize(query));
  if (queryTokens.length === 0) {
    return {
      ok: true,
      command,
      query,
      total_docs: totalDocs,
      hits: [],
      note: 'query tokenized to empty after normalization',
    };
  }

  const df = new Map();
  for (const term of queryTokens) {
    let count = 0;
    for (const doc of normalizedDocs) {
      if (doc.tf.has(term)) count += 1;
    }
    df.set(term, count);
  }

  const hits = normalizedDocs
    .map((doc) => {
      let score = 0;
      const matched = [];
      for (const term of queryTokens) {
        const tf = doc.tf.get(term) || 0;
        if (tf === 0) continue;
        const docFreq = df.get(term) || 0;
        const idf = Math.log(1 + (totalDocs - docFreq + 0.5) / (docFreq + 0.5));
        const norm = tf * (k1 + 1) /
          (tf + k1 * (1 - b + b * (doc.length / Math.max(avgDocLen, 1))));
        const termScore = idf * norm;
        score += termScore;
        matched.push({ term, tf, idf: round4(idf), score: round4(termScore) });
      }
      return {
        doc_id: doc.doc_id,
        title: doc.title,
        url: doc.url,
        source_type: doc.source_type,
        score: round4(score),
        matched_terms: matched.sort((a, b) => b.score - a.score),
        snippet: buildSnippet(doc.text, queryTokens),
      };
    })
    .filter((hit) => hit.score > minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return {
    ok: true,
    command,
    query,
    total_docs: totalDocs,
    avg_doc_length: Math.round(avgDocLen * 100) / 100,
    query_tokens: queryTokens,
    scorer: 'bm25',
    hits,
  };
}

function tokenize(value) {
  const text = String(value || '').normalize('NFKC').toLowerCase();
  if (!text) return [];
  const tokens = [];
  const latinPattern = /[a-z0-9][a-z0-9_\-]*/g;
  for (const match of text.matchAll(latinPattern)) {
    tokens.push(match[0]);
  }
  // CJK: bigram tokenization for cheap recall on Chinese.
  const cjk = text.replace(/[^\u4e00-\u9fa5]+/g, ' ');
  for (const segment of cjk.split(/\s+/)) {
    if (!segment) continue;
    if (segment.length === 1) {
      tokens.push(segment);
      continue;
    }
    for (let i = 0; i < segment.length - 1; i += 1) {
      tokens.push(segment.slice(i, i + 2));
    }
  }
  return tokens.filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'for', 'and', 'or', 'in', 'on', 'is', 'are',
  '的', '了', '和', '与', '及', '在', '是', '就',
]);

function termFrequency(tokens) {
  const tf = new Map();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) || 0) + 1);
  }
  return tf;
}

function uniqueTokens(tokens) {
  return Array.from(new Set(tokens));
}

function buildSnippet(text, queryTokens, radius = 30) {
  if (!text) return '';
  const lower = text.toLowerCase();
  let bestIdx = -1;
  for (const term of queryTokens) {
    const idx = lower.indexOf(term);
    if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) bestIdx = idx;
  }
  if (bestIdx < 0) {
    return text.slice(0, Math.min(radius * 2, text.length));
  }
  const start = Math.max(0, bestIdx - radius);
  const end = Math.min(text.length, bestIdx + radius * 2);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

function checkpointSet(input) {
  const job = requireKey(input, 'job');
  const cursor = input.cursor ?? null;
  const storePath = checkpointPath();
  const store = readJsonFile(storePath, {});
  const previous = store[job] || null;
  const now = new Date().toISOString();
  const checkpoint = {
    job,
    cursor,
    batch_id: input.batch_id ?? null,
    updated_at: now,
    meta: input.meta ?? {},
  };
  store[job] = checkpoint;
  writeJsonFileAtomic(storePath, store);
  return {
    ok: true,
    command,
    job,
    previous,
    checkpoint,
  };
}

function lockAcquire(input) {
  const job = requireKey(input, 'job');
  const meetingId = requireKey(input, 'meeting_id');
  const ttlSeconds = clampNumber(Number(input.ttl_seconds ?? 600), 30, 86400);
  const owner = stringValue(input.owner) || `${process.pid}`;
  const lockPath = lockFilePath(job, meetingId);
  ensureDir(path.dirname(lockPath));

  const nowMs = Date.now();
  const lock = {
    job,
    meeting_id: meetingId,
    owner,
    acquired_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + ttlSeconds * 1000).toISOString(),
    ttl_seconds: ttlSeconds,
  };

  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify(lock, null, 2));
    fs.closeSync(fd);
    return { ok: true, command, acquired: true, lock };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  const existing = readJsonFile(lockPath, null);
  const expired = !existing?.expires_at || Date.parse(existing.expires_at) <= nowMs;
  if (expired) {
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return lockAcquire(input);
  }

  return {
    ok: true,
    command,
    acquired: false,
    reason: 'lock_exists',
    lock: existing,
  };
}

function lockRelease(input) {
  const job = requireKey(input, 'job');
  const meetingId = requireKey(input, 'meeting_id');
  const owner = stringValue(input.owner);
  const lockPath = lockFilePath(job, meetingId);
  const existing = readJsonFile(lockPath, null);
  if (!existing) {
    return {
      ok: true,
      command,
      released: false,
      reason: 'lock_missing',
    };
  }
  if (owner && existing.owner && owner !== existing.owner) {
    return {
      ok: false,
      command,
      released: false,
      error: 'lock_owner_mismatch',
      lock: existing,
    };
  }
  fs.unlinkSync(lockPath);
  return {
    ok: true,
    command,
    released: true,
    lock: existing,
  };
}

function checkpointPath() {
  return path.join(stateDir(), 'checkpoints.json');
}

function lockFilePath(job, meetingId) {
  const key = sha256Short(`${job}|${meetingId}`, 24);
  return path.join(stateDir(), 'locks', `${normalizeToken(job)}-${key}.lock`);
}

function stateDir() {
  return path.join(process.cwd(), '.meetingflow', 'state');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function writeJsonFileAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tempPath, filePath);
}

function requireKey(input, key) {
  const value = stringValue(input[key]);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function ratio(numerator, denominator, emptyDefault) {
  const den = Number(denominator);
  if (!Number.isFinite(den) || den <= 0) return emptyDefault;
  const num = Number(numerator);
  if (!Number.isFinite(num)) return 0;
  return clamp01(num / den);
}

function clamp01(value) {
  return clampNumber(value, 0, 1);
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function sha256Short(value, length = 16) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeToken(value) {
  const normalized = stringValue(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9_\-\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'unknown';
}

function normalizeLoose(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\r\n/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n+/g, '\n')
    .trim();
}

function normalizeCompact(value) {
  return normalizeLoose(value).replace(/[\s\p{P}\p{S}]+/gu, '');
}

function normalizeForHash(value) {
  return normalizeCompact(value);
}

function normalizeSemantic(value) {
  return normalizeCompact(value)
    .replace(/^(结论|决定|任务|待办|风险|问题)[:：]/, '')
    .trim();
}
