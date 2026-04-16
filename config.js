import { env } from 'process';
import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

// Load environment variables from .env file
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.join(__dirname, '.env') });

/**
 * @typedef {object} BotConfig
 * @property {string} name - Bot显示名称
 * @property {string} [password] - Bot密码
 * @property {string} [clientUsername] - 客户端登录用户名
 * @property {string} [clientPassword] - 客户端登录密码
 */

/**
 * @typedef {object} WikiConfig
 * @property {string} api - Wiki API地址
 * @property {BotConfig} bot - Bot配置
 */

/**
 * @typedef {object} Config
 * @property {string} useragent - User-Agent字符串
 * @property {string} [password] - 默认密码
 * @property {WikiConfig} zh - 中文维基配置
 * @property {WikiConfig} cm - 共享资源维基配置
 */

/** @type {Config} */
const config = {
	useragent: `moegirlSSOToken=${env.MOEGIRL_SSO_TOKEN},moegirlSSOUserID=${env.MOEGIRL_SSO_USER_ID}`,
	password: env.MOEGIRL_PASSWORD, // for clientLogin
	zh: {
		api: 'https://mzh.moegirl.org.cn/api.php',
		bot: {
			name: '机娘穆斯塔法@Kemal-Bot',
			password: env.MOEGIRL_PASSWORD,
			clientPassword: env.MOEGIRL_CLIENT_PASSWORD,
			clientUsername: env.MOEGIRL_CLIENT_USERNAME,
		},
	},
	cm: {
		api: 'https://commons.moegirl.org.cn/api.php',
		bot: {
			name: '机娘穆斯塔法@Kemal-Bot',
			password: env.MOEGIRL_PASSWORD,
		},
	},
};


export default config;