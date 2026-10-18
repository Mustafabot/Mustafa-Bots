import type { TaskDescriptor } from './descriptor.js';

/**
 * 可供 GUI 驱动的任务清单。
 *
 * 每个条目只描述"怎么拼命令行"，不描述"怎么解析输出"——输出统一走 progress.ts 的事件协议。
 */
export const DESCRIPTORS: TaskDescriptor[] = [
	{
		id: 'text-replace',
		label: '全站文本替换',
		entry: 'src/replace/TextReplace.ts',
		style: 'space',
		progressFlag: '--progress-json',
		quietFlag: '--quiet',
		page: 'text-replace',
		configFileFlag: '--config-file',
		configSource: 'rulesets',
		params: [
			{
				kind: 'enum',
				flag: '--wiki',
				label: '目标站点',
				default: 'zh',
				options: [
					{ value: 'zh', label: '萌娘百科' },
					{ value: 'cm', label: '共享站' },
				],
			},
			{ kind: 'stringList', flag: '--namespace', label: '命名空间', separator: ',', description: '留空则用规则集内声明的范围' },
			{ kind: 'string', flag: '--summary', label: '编辑摘要', placeholder: '留空则自动生成' },
			{ kind: 'boolean', flag: '--scan-only', label: '只扫描不修改，命中结果落盘供预览' },
			{ kind: 'stringList', flag: '--add-namespaces', separator: ',', label: '加入镜像并同步的命名空间', description: '把未同步的命名空间抓进本地镜像，抓完即可搜索' },
			{ kind: 'boolean', flag: '--no-sync', label: '跳过镜像同步，直接用现有镜像搜索' },
			{ kind: 'number', flag: '--interval', label: '编辑间隔（毫秒）', default: 1500, min: 0 },
			{ kind: 'boolean', flag: '--sync-only', label: '仅同步镜像，不做替换' },
			{ kind: 'boolean', flag: '--dry-run', label: '空跑，不提交任何编辑' },
			{ kind: 'boolean', flag: '--reset', label: '丢弃编辑断点重跑（镜像保留）' },
			{ kind: 'boolean', flag: '--resync', label: '清空镜像重新全量同步', danger: true },
			{ kind: 'boolean', flag: '--purge-deleted', label: '真正删除线上已不存在的页面', danger: true },
		],
	},
	{
		id: 'auto-patrol',
		label: '自动巡查',
		entry: 'src/patrol/AutoPatrol.ts',
		style: 'equals',
		progressFlag: '--progress-json',
		quietFlag: '--quiet',
		params: [
			{
				kind: 'enum',
				flag: '--mode',
				label: '巡查模式',
				default: 'all',
				options: [
					{ value: 'edit', label: '仅编辑巡查' },
					{ value: 'moved', label: '仅新页面打回巡查' },
					{ value: 'all', label: '两阶段都做' },
				],
			},
			{
				kind: 'enum',
				flag: '--wiki',
				label: '目标站点',
				default: 'both',
				options: [
					{ value: 'zh', label: '萌娘百科' },
					{ value: 'cm', label: '共享站' },
					{ value: 'both', label: '两站' },
				],
			},
			{ kind: 'number', flag: '--days', label: '回溯天数', default: 30, min: 1 },
			{ kind: 'number', flag: '--interval', label: '请求间隔（毫秒）', default: 4000, min: 0 },
			{ kind: 'number', flag: '--limit', label: '数量上限', default: 0, min: 0, description: '0 表示不限' },
			{ kind: 'boolean', flag: '--dry-run', label: '空跑，不实际巡查' },
		],
	},
	{
		id: 'url-upload',
		label: 'URL 上传',
		entry: 'src/upload/UrlUpload.ts',
		style: 'space',
		page: 'url-upload',
		configFileFlag: '--config-file',
		configSource: 'upload-tasks',
		progressFlag: '--progress-json',
		quietFlag: '--quiet',
		params: [
			{ kind: 'boolean', flag: '--check', label: '只检查线上状态，不上传' },
			{ kind: 'boolean', flag: '--only-missing', label: '只上传线上不存在的文件' },
			{ kind: 'boolean', flag: '--dry-run', label: '空跑，不提交任何上传' },
		],
	},
];

export function findDescriptor(id: string): TaskDescriptor | undefined {
	return DESCRIPTORS.find((descriptor) => descriptor.id === id);
}
