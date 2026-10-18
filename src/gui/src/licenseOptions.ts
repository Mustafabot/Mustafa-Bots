// 授权协议选项：与 src/upload/uploadConfig.ts 的 LICENSE_OPTIONS 逐条一致。
// 界面不能直接 import 脚本侧的模块（那边是 Node 环境），故在此镜像一份；
// 改一边就要改另一边，值（value）是写进文件页正文的模板名，不能随意改。
export interface LicenseOption {
	group: string;
	value: string;
	label: string;
	title?: string;
}

export const LICENSE_OPTIONS: ReadonlyArray<LicenseOption> = [
	{ group: 'CC协议', value: 'CC Zero', label: 'CC-0', title: '作者授权以无著作权方式使用' },
	{ group: 'CC协议', value: 'CC BY', label: 'CC BY 3.0', title: '作者授权以署名方式使用，该授权需兼容 3.0 协议' },
	{ group: 'CC协议', value: 'CC BY-SA', label: 'CC BY-SA 3.0', title: '作者授权以署名-相同方式使用，该授权需兼容 3.0 协议' },
	{ group: 'CC协议', value: 'CC BY-NC-SA', label: 'CC BY-NC-SA 3.0', title: '作者授权以署名-非商业使用-相同协议使用，该授权需兼容 3.0 协议' },
	{ group: '公有领域', value: 'PD-Old', label: '作者离世一定年限后流入公有领域' },
	{ group: '公有领域', value: 'PD-Other', label: '其他原因流入公有领域' },
	{ group: '其他', value: 'Copyright', label: '原作者保留权利', title: '原作者没有明确的授权声明' },
	{ group: '其他', value: 'none:gotoCommons', label: '原作者授权萌百使用' },
	{ group: '其他', value: '可自由使用', label: '可自由使用', title: '作者放弃版权或声明可自由使用' },
	{ group: '其他', value: '萌娘百科版权所有', label: '萌娘百科版权所有' },
];
