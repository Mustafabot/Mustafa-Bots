import { env } from 'process';
import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.join(__dirname, '.env') });

interface BotConfig {
	name: string;
	password?: string;
	clientUsername?: string;
	clientPassword?: string;
}

interface WikiConfig {
	api: string;
	cookie?: string;
	bot: BotConfig;
}

interface Config {
	useragent?: string;
	password?: string;
	zh: WikiConfig;
	cm: WikiConfig;
}

const config: Config = {
	password: env.MOEGIRL_PASSWORD,
	zh: {
		api: 'https://mzh.moegirl.org.cn/api.php',
		cookie: `moegirlSSOToken=${env.MOEGIRL_ZH_SSO_TOKEN},moegirlSSOUserID=${env.MOEGIRL_ZH_SSO_USER_ID}`,
		bot: {
			name: '机娘穆斯塔法@Kemal-Bot',
			password: env.MOEGIRL_PASSWORD,
			clientPassword: env.MOEGIRL_CLIENT_PASSWORD,
			clientUsername: env.MOEGIRL_CLIENT_USERNAME,
		},
	},
	cm: {
		api: 'https://commons.moegirl.org.cn/api.php',
		cookie: `moegirlSSOToken=${env.MOEGIRL_CM_SSO_TOKEN},moegirlSSOUserID=${env.MOEGIRL_CM_SSO_USER_ID}`,
		bot: {
			name: '机娘穆斯塔法@Kemal-Bot',
			password: env.MOEGIRL_PASSWORD,
			clientPassword: env.MOEGIRL_CLIENT_PASSWORD,
			clientUsername: env.MOEGIRL_CLIENT_USERNAME,
		},
	},
};

export default config;
