import process from 'process';
import config from './config.js';

/**
 * @param {import('../src').MediaWikiApi} api
 * @param {string} username
 * @param {string} [password=config.password]
 * @param {string} [loginreturnurl] - 登录返回URL，默认使用zh站API
 * @returns {Promise<any>} 登录结果
 */
async function clientLogin(api, username, password = config.password, loginreturnurl = config.zh.api) {
	return api
		.postWithToken(
			'login',
			{
				action: 'clientlogin',
				username,
				password,
				loginreturnurl,
			},
			{
				tokenName: 'logintoken',
				retry: 15,
				noCache: true,
			},
		)
		.then(({ data }) => {
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