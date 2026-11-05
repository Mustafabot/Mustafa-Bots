/**
 * PurgeBacklinks 的命令行参数解析。
 *
 * 抽成纯函数（与界面无关、不碰网络），便于 node:test 直接覆盖——
 * 脚本本体是自执行 IIFE，无法在测试里 import。
 */

export interface CliArgs {
	/** 目标页面标题（唯一的位置参数，必填） */
	title: string;
	dryRun: boolean;
	/** 是否输出人类可读日志；`--quiet` 关闭 */
	verbose: boolean;
	/** 用零编辑代替 purge */
	nulledit: boolean;
	concurrency: number;
	/** 输出 GUI 进度事件行；普通命令行运行不产生事件行 */
	progressJson: boolean;
}

export const USAGE =
	'用法: npx tsx src/purge/PurgeBacklinks.ts <页面标题> [--nulledit] [--concurrency <n>] [--dry-run] [--quiet] [--progress-json]';

/** 默认并发数，与 CLI 帮助一致 */
export const DEFAULT_CONCURRENCY = 3;

/** 并发上限：手滑填大数时挡住，避免一次性轰出过多请求 */
export const MAX_CONCURRENCY = 16;

/**
 * 解析并发数：非法值（缺值、非数字、0、负数）回退默认值，超过上限则截断。
 * 原先直接 `parseInt` 会让 NaN 一路传到 `Array.from({ length: NaN })`，
 * 结果是零个工作线程、静默什么都不做。
 */
function parseConcurrency(raw: string | undefined, fallback: number): number {
	const value = Number.parseInt(raw ?? '', 10);
	if (!Number.isFinite(value) || value < 1) return fallback;
	return Math.min(value, MAX_CONCURRENCY);
}

/** 解析 argv；缺页面标题时返回 null，由调用方打印用法并退出 */
export function parseArgs(args: string[]): CliArgs | null {
	const result: CliArgs = {
		title: '',
		dryRun: false,
		verbose: true,
		nulledit: false,
		concurrency: DEFAULT_CONCURRENCY,
		progressJson: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--dry-run') {
			result.dryRun = true;
		} else if (arg === '--quiet') {
			result.verbose = false;
		} else if (arg === '--nulledit') {
			result.nulledit = true;
		} else if (arg === '--progress-json') {
			result.progressJson = true;
		} else if ((arg === '--concurrency' || arg === '-c') && args[i + 1]) {
			result.concurrency = parseConcurrency(args[i + 1], DEFAULT_CONCURRENCY);
			i++;
		} else if (!arg.startsWith('--') && !arg.startsWith('-')) {
			// 位置参数：后出现的覆盖先出现的（与原有行为一致）
			result.title = arg;
		}
	}

	if (!result.title) return null;

	return result;
}
