// 术语匹配：屏蔽占位符/标签后，按术语长度降序 + 词边界 + 区间去重进行匹配，
// 避免短术语抢占长术语内部的子串（如 COMMON 命中 UNCOMMON）以及标签内的明文误报。

export function maskSource(text) {
  if (!text) return '';
  return text
    // 占位符/引擎标签整体删除：<GEO{}> <468807-THEN{...}> <col{...}> 等
    .replace(/<[^>]*>/g, ' ')
    // 裸 {placeholder}
    .replace(/\{[^}]*\}/g, ' ')
    // printf 类：%s %d %1$s %.2f 等
    .replace(/%[\d$.\-]*[sdifxX]/g, ' ')
    // bbcode：只删标记 [color=WHITE] [/color]，保留中间文字
    .replace(/\[\/?[^\]]*\]/g, ' ');
}

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 按术语长度降序排序，并为每个术语生成匹配用的正则。
// 含拉丁字母的术语加 \b 词边界；纯 CJK 术语没有词边界概念，退回普通匹配。
export function buildMatchers(glossary) {
  return (glossary || [])
    .filter(t => t && t.source)
    .slice()
    .sort((a, b) => b.source.length - a.source.length)
    .map(term => {
      const flags = term.caseSensitive ? 'g' : 'gi';
      const re = /[A-Za-z]/.test(term.source)
        ? new RegExp('\\b' + escapeRegExp(term.source) + '\\b', flags)
        : new RegExp(escapeRegExp(term.source), flags);
      return { term, re };
    });
}

// 在一行源文里找命中的术语：长术语优先认领字符区间，短术语在已认领区间内跳过。
export function findTermsInSource(rawSource, matchers) {
  if (!rawSource) return [];
  const masked = maskSource(rawSource);
  const claimed = [];
  const hits = [];
  for (const m of matchers) {
    m.re.lastIndex = 0;
    let match;
    while ((match = m.re.exec(masked)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      const overlaps = claimed.some(([s, e]) => start < e && end > s);
      if (!overlaps) {
        hits.push({ term: m.term, start, end });
        claimed.push([start, end]);
      }
      if (match[0].length === 0) m.re.lastIndex++; // 防零宽死循环
    }
  }
  return hits;
}

// 供高亮/术语列展示用：某一行命中的去重术语列表，按出现顺序排列。
export function findMatchedTerms(rawSource, matchers) {
  const hits = findTermsInSource(rawSource, matchers).sort((a, b) => a.start - b.start);
  const seen = new Set();
  const result = [];
  for (const h of hits) {
    if (!seen.has(h.term)) {
      seen.add(h.term);
      result.push(h.term);
    }
  }
  return result;
}

export const DEFAULT_DRIFT_THRESHOLD = 0.6;

// 全局共识分级：先全表统计每个术语的命中/未命中率，再分成两类——
// 命中率高、少数行未命中 = 真·逐行不一致（likelyErrors，逐行报）；
// 缺失率极高 = 术语库大概率过时（glossaryDrift，聚合成一条，不逐行刷屏）。
export function analyzeConsistency(sourceRows, matchers, opts = {}) {
  const driftThreshold = opts.driftThreshold ?? DEFAULT_DRIFT_THRESHOLD;
  const stat = new Map(); // term -> { hit, miss, missRows: [{ rowNo, source, actual }] }

  (sourceRows || []).forEach(({ rowNo, source, target }) => {
    if (!source || !target) return; // 未填译文的行不参与统计
    const hits = findTermsInSource(source, matchers);
    hits.forEach(h => {
      const rec = stat.get(h.term) ?? { hit: 0, miss: 0, missRows: [] };
      if (target.includes(h.term.target)) {
        rec.hit++;
      } else {
        rec.miss++;
        rec.missRows.push({ rowNo, source, actual: target });
      }
      stat.set(h.term, rec);
    });
  });

  const glossaryDrift = [];
  const likelyErrors = [];
  stat.forEach((rec, term) => {
    const total = rec.hit + rec.miss;
    if (total === 0 || rec.miss === 0) return;
    const missRate = rec.miss / total;
    if (missRate >= driftThreshold) {
      glossaryDrift.push({
        source: term.source,
        expected: term.target,
        missCount: rec.miss,
        hitCount: rec.hit,
        missRows: rec.missRows,
      });
    } else {
      rec.missRows.forEach(mr => {
        likelyErrors.push({ row: mr.rowNo, source: mr.source, expected: term.target, actual: mr.actual, missRate: +missRate.toFixed(3) });
      });
    }
  });

  return { glossaryDrift, likelyErrors };
}

export const DEFAULT_MIN_SOURCE_LEN = 40;
export const DEFAULT_RATIO_FLOOR = 0.15;

// 漏译/截断检测：剥掉标签/占位符后比较源文与译文的可翻译文本长度。
// 独立于术语匹配——逮的是"译文为空"或"源文长、译文短得不合理"这类问题。
export function detectMissingTranslations(sourceRows, opts = {}) {
  const minSourceLen = opts.minSourceLen ?? DEFAULT_MIN_SOURCE_LEN;
  const ratioFloor = opts.ratioFloor ?? DEFAULT_RATIO_FLOOR;
  const out = [];

  (sourceRows || []).forEach(({ rowNo, source, target }) => {
    const srcText = maskSource(source || '').replace(/\s+/g, '');
    const tgtText = maskSource(target || '').replace(/\s+/g, '');

    if (srcText.length === 0) return; // 纯标签/数字/符号行，跳过

    if (tgtText.length === 0) {
      out.push({ rowNo, type: 'EMPTY', srcLen: srcText.length, tgtLen: 0, note: '译文为空' });
      return;
    }

    if (srcText.length >= minSourceLen) {
      const ratio = tgtText.length / srcText.length;
      if (ratio < ratioFloor) {
        out.push({
          rowNo, type: 'TRUNCATED', srcLen: srcText.length, tgtLen: tgtText.length,
          ratio: +ratio.toFixed(3),
          note: `源文 ${srcText.length} 字，译文仅 ${tgtText.length} 字（${(ratio * 100).toFixed(0)}%）`,
        });
      }
    }
  });

  return out;
}

// 置信度打分：整词精确命中打底 0.9，短译法/贴标签/少数派程度不明显时降分。
export function scoreConfidence(finding) {
  let c = 0.9;
  const t = finding.expected || '';
  if ([...t].length <= 2) c -= 0.35; // 1-2 字译法，子串可靠性低，容易误命中别的词
  if (finding.nearTag) c -= 0.20; // 命中点贴近标签边界，可能是标签残留（v1 默认不启用该信号）
  if (finding.missRate != null) c -= Math.max(0, finding.missRate - 0.1) * 0.3; // 少数派越明显越可信
  return Math.max(0.1, Math.min(0.99, +c.toFixed(2)));
}

export const DEFAULT_REVIEW_BELOW = 0.6;

// 把术语结果（glossaryDrift + likelyErrors）和漏译结果合并成一张分档、带置信度、排好序的报告。
// 纯展示层：不改前面任何检测逻辑，只做去重（漏译行优先，抑制其术语级噪音）、打分、排序。
export function buildTieredReport({ glossaryDrift, likelyErrors }, missing, opts = {}) {
  const reviewBelow = opts.reviewBelow ?? DEFAULT_REVIEW_BELOW;
  const report = [];

  // 漏译：最高优先
  const missingRows = new Set();
  (missing || []).forEach(m => {
    missingRows.add(m.rowNo);
    report.push({
      tier: 'MISSING', icon: '🟥', rowNo: m.rowNo, confidence: 0.95,
      label: m.type === 'EMPTY' ? '译文为空' : '疑似漏译/截断', detail: m.note,
    });
  });

  // 逐行不一致：按置信度分 CONFIRMED/REVIEW；已判为漏译的行跳过（症状而非真错）
  (likelyErrors || []).forEach(e => {
    if (missingRows.has(e.row)) return;
    const conf = scoreConfidence(e);
    const confirmed = conf >= reviewBelow;
    report.push({
      tier: confirmed ? 'CONFIRMED' : 'REVIEW',
      icon: confirmed ? '🔴' : '🟡',
      rowNo: e.row, confidence: conf,
      label: confirmed ? '术语不一致（建议改译文）' : '疑似不一致（请复核）',
      detail: `${e.source} → 期待 ${e.expected}`,
      source: e.source, expected: e.expected, actual: e.actual,
    });
  });

  // 术语库漂移：聚合，做决策
  (glossaryDrift || []).forEach(d => report.push({
    tier: 'GLOSSARY_DRIFT', icon: '🔵', rowNo: null,
    confidence: +(d.missCount / (d.missCount + d.hitCount)).toFixed(2),
    label: '术语库疑似过时（建议改库）',
    detail: `${d.source}: 未用 ${d.expected} ${d.missCount} 处 / 用了 ${d.hitCount} 处`,
    source: d.source, expected: d.expected, missCount: d.missCount, hitCount: d.hitCount, missRows: d.missRows,
  }));

  // 排序：先按档位优先级，再按置信度降序
  const order = { MISSING: 0, CONFIRMED: 1, GLOSSARY_DRIFT: 2, REVIEW: 3 };
  report.sort((a, b) => order[a.tier] - order[b.tier] || b.confidence - a.confidence);
  return report;
}

// 报告条目的去重/"不再提醒"键：GLOSSARY_DRIFT 按 source+expected 聚合（不分行），
// MISSING 按行号（一行一条），CONFIRMED/REVIEW 按行号+source+expected。
export function reportItemKey(item) {
  if (item.tier === 'GLOSSARY_DRIFT') return `GLOSSARY_DRIFT|${item.source}|${item.expected}`;
  if (item.tier === 'MISSING') return `MISSING|${item.rowNo}`;
  return `${item.tier}|${item.rowNo}|${item.source}|${item.expected}`;
}
