/**
 * 扫描结果的读取服务：给界面列出结果、按页取命中明细。
 * 只读不写——写入由替换脚本的 --scan-only 完成。
 */
import { resolve } from 'node:path';
import { listScanResults, readScanResult, type ScanPageHit, type ScanResultMeta } from '../replace/scanResult.js';

/** 扫描结果文件名白名单：站名 + 12 位十六进制指纹 + .json，其余一律拒绝 */
const NAME_PATTERN = /^scan_[a-z]+_[0-9a-f]{12}\.json$/;

export interface ScanPageSlice {
	meta: ScanResultMeta;
	/** 命中页总数 */
	total: number;
	offset: number;
	limit: number;
	hits: ScanPageHit[];
}

export class ScanStore {
	private readonly dir: string;

	constructor(dir: string = resolve('data/gui/scans')) {
		this.dir = dir;
	}

	list(): ScanResultMeta[] {
		return listScanResults(this.dir);
	}

	/** 取单个结果的一段命中；文件名不合法或读不出来都返回 null */
	page(name: string, offset: number, limit: number): ScanPageSlice | null {
		if (!NAME_PATTERN.test(name)) return null;
		const result = readScanResult(this.dir, name);
		if (!result) return null;
		const { hits, ...meta } = result;
		return {
			meta: { ...meta, hitCount: hits.length },
			total: hits.length,
			offset,
			limit,
			hits: hits.slice(offset, offset + limit),
		};
	}
}
