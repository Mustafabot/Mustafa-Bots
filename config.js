console.log(process.env.DB_PASSWORD);

const config = {
	//useragent: `${env.MOEGIRL_API_USER_AGENT} (Github Actions; Mustafa-Bots) `, // for WAF
	MainUser: '穆斯塔法凯末尔',
	BotUser:'机娘穆斯塔法',
	password: env.MOEGIRL_PASSWORD, // for clientLogin
	/**zh: {
		api: 'https://mzh.moegirl.org.cn/api.php',
		bot: {
			name: '机娘穆斯塔法',
			password: env.BOT,
		},
	},
	cm: {
		api: 'https://commons.moegirl.org.cn/api.php',
		bot: {
			name: '机娘穆斯塔法',
			password: env.BOT,
		},
	},*/
};

export default config;