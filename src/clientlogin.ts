import process from 'process';
import { MediaWikiApi } from 'wiki-saikou';
import config from './config.js';

interface ClientLoginData {
	clientlogin: {
		status: string;
		message?: string;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

async function clientLogin(
	api: MediaWikiApi,
	username: string,
	password: string = config.password!,
	loginreturnurl: string = config.zh.api,
): Promise<ClientLoginData> {
	return api
		.postWithToken<ClientLoginData>(
			'login',
			{
				action: 'clientlogin',
				username: username,
				password: password,
				loginreturnurl,
			},
			{
				tokenName: 'logintoken',
				retry: 15,
				noCache: true,
			} as Parameters<typeof api.postWithToken>[2],
		)
		.then(({ data }) => {
			if (!data.clientlogin) {
				console.error('登录异常: 响应中缺少 clientlogin 数据', data);
				throw new Error('登录响应格式异常');
			}
			if (data.clientlogin.status === 'PASS') {
				console.log('登录成功', data);
				return data;
			}
			throw new Error(data.clientlogin.message);
		})
		.catch((err) => {
			console.error('登录异常', err);
			process.exit(1);
		});
}

export default clientLogin;
