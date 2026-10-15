/**
 * 扫描结果的落盘格式与读写。
 *
 * 扫描只搜不改，结果存 `data/gui/scans/`，文件名带规则指纹——规则一改指纹就变，
 * 旧结果自然失效。结果里不存整页正文，只存每处命中的行号、该行原文与匹配串，
 * 界面按页展开时不必再去碰镜像库。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { MatchSpan, PreparedRule, ReplaceRule } from './replaceRules.js';

/** 一处命中所在的行 */
export interface ScanMatchLine {
	/** 行号，从 1 开始 */
	line: number;
	/** 该行原文（去掉了行尾的 \r） */
	text: string;
	/** 匹配到的字串 */
	match: string;
	/** 命中的规则在 rules 数组中的下标 */
	rule: number;
}

/** 一个命中页面 */
export interface ScanPageHit {
	title: string;
	/** 真实命中处数（明细被截断时大于 matches.length） */
	hits: number;
	matches: ScanMatchLine[];
}

/** 一次扫描的完整结果 */
export interface ScanResult {
	/** 结果格式版本，日后改格式时用来识别旧文件 */
	version: 1;
	wiki: string;
	/** 规则指纹，同规则重扫覆盖同一文件 */
	fingerprint: string;
	namespaces: number[];
	rules: ReplaceRule[];
	/** 本次扫描过的镜像页数 */
	scanned: number;
	createdAt: number;
	hits: ScanPageHit[];
}

/** 列表用的元信息：去掉命中明细，另给命中页数 */
export type ScanResultMeta = Omit<ScanResult, 'hits'> & { hitCount: number };

/** 每页最多保留多少条命中明细；命中处数仍按真实值记录 */
export const MAX_MATCH_DETAIL = 50;
/** 扫描结果的保留天数，写入新结果时顺带清理 */
export const SCAN_TTL_DAYS = 14;

/**
 * 提取命中明细：返回总命中处数，以及按全文位置排序的行明细（最多 cap 条）。
 * 多行正则的命中记在它开始的那一行。
 */
export function collectMatchLines(text: string, rules: PreparedRule[], cap = MAX_MATCH_DETAIL): { hits: number; matches: ScanMatchLine[] } {
	// 只按 \n 切分，因此每行起点偏移可以精确算出来，不会被 \r\n 平移
	const lines = text.split('\n');
	const lineStarts: number[] = [];
	let offset = 0;
	for (const line of lines) {
		lineStarts.push(offset);
		offset += line.length + 1;
	}
	const locate = (index: number): number => {
		let low = 0;
		let high = lineStarts.length - 1;
		while (low < high) {
			const mid = (low + high + 1) >> 1;
			if (lineStarts[mid] <= index) low = mid;
			else high = mid - 1;
		}
		return low;
	};

	const spans: Array<MatchSpan & { rule: number }> = [];
	for (const [rule, prepared] of rules.entries()) {
		for (const span of prepared.findMatches(text)) spans.push({ ...span, rule });
	}
	spans.sort((a, b) => a.index - b.index || a.rule - b.rule);

	const matches: ScanMatchLine[] = [];
	for (const span of spans.slice(0, cap)) {
		const row = locate(span.index);
		matches.push({ line: row + 1, text: lines[row].replace(/\r$/, ''), match: span.value, rule: span.rule });
	}
	return { hits: spans.length, matches };
}

/** 扫描结果文件名：站名 + 规则指纹前 12 位，同规则重扫覆盖同一文件 */
export function scanFileName(wiki: string, fingerprint: string): string {
	return `scan_${wiki}_${fingerprint.slice(0, 12)}.json`;
}

/** 写入扫描结果（顺带清理过期结果），返回文件名 */
export function writeScanResult(dir: string, result: ScanResult): string {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	pruneScanResults(dir);
	const name = scanFileName(result.wiki, result.fingerprint);
	// 不做缩进美化：结果可能上万条命中，缩进会让文件凭空大一倍
	writeFileSync(resolve(dir, name), JSON.stringify(result), 'utf-8');
	return name;
}

/** 读取单个扫描结果；文件不存在、损坏或格式不符时返回 null */
export function readScanResult(dir: string, name: string): ScanResult | null {
	const file = resolve(dir, name);
	if (!existsSync(file)) return null;
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf-8')) as ScanResult;
		if (parsed?.version !== 1 || !Array.isArray(parsed.hits)) return null;
		return parsed;
	} catch {
		return null;
	}
}

/** 列出全部扫描结果的元信息，按创建时间从新到旧；损坏的文件跳过 */
export function listScanResults(dir: string): ScanResultMeta[] {
	if (!existsSync(dir)) return [];
	const results: ScanResultMeta[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith('.json')) continue;
		const parsed = readScanResult(dir, file);
		if (!parsed) continue;
		const { hits, ...meta } = parsed;
		results.push({ ...meta, hitCount: hits.length });
	}
	return results.sort((a, b) => b.createdAt - a.createdAt);
}

/** 清掉超过保留期的旧结果文件 */
function pruneScanResults(dir: string): void {
	const threshold = Date.now() - SCAN_TTL_DAYS * 86400000;
	for (const file of readdirSync(dir)) {
		if (!file.endsWith('.json')) continue;
		const target = resolve(dir, file);
		try {
			if (statSync(target).mtimeMs < threshold) rmSync(target);
		} catch {
			// 并发写入导致文件刚好消失：忽略即可，下次写入还会再清
		}
	}
}
