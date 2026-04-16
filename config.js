import { env } from 'process';
import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

// Load environment variables from .env file
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.join(__dirname, '.env') });

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