import { env } from 'process';
import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import path from 'path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = existsSync(path.join(__dirname, '.env'))
    ? path.join(__dirname, '.env')
    : path.join(__dirname, '..', '.env');
dotenvConfig({ path: envPath });
const config = {
    password: env.MOEGIRL_PASSWORD,
    zh: {
        api: 'https://zh.moegirl.org.cn/api.php',
        cookie: `moegirlSSOToken=${env.MOEGIRL_ZH_SSO_TOKEN},moegirlSSOUserID=${env.MOEGIRL_SSO_USER_ID}`,
        bot: {
            name: '机娘穆斯塔法@Kemal-Bot',
            password: env.MOEGIRL_PASSWORD,
            clientPassword: env.MOEGIRL_CLIENT_PASSWORD,
            clientUsername: env.MOEGIRL_CLIENT_USERNAME,
        },
    },
    cm: {
        api: 'https://commons.moegirl.org.cn/api.php',
        cookie: `moegirlSSOToken=${env.MOEGIRL_CM_SSO_TOKEN},moegirlSSOUserID=${env.MOEGIRL_SSO_USER_ID}`,
        bot: {
            name: '机娘穆斯塔法@Kemal-Bot',
            password: env.MOEGIRL_PASSWORD,
            clientPassword: env.MOEGIRL_CLIENT_PASSWORD,
            clientUsername: env.MOEGIRL_CLIENT_USERNAME,
        },
    },
};
export default config;
