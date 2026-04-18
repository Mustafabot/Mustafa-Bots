import { MediaWikiApi } from 'wiki-saikou';
import config from './config.js';
import clientlogin from './clientlogin.js';
const bot = new MediaWikiApi(config.zh.api, {
    headers: { cookie: config.zh.cookie },
});
await clientlogin(bot, config.zh.bot.clientUsername, config.zh.bot.clientPassword)
    .then((result) => { console.log(result); })
    .then(() => {
    return bot.postWithToken('csrf', {
        action: 'edit',
        title: 'User:没有羽翼的格雷塔/SandBox',
        text: '{{About|{{User|没有羽翼的格雷塔}}的沙盒|与其他用户共享的积压工作列表|User:没有羽翼的格雷塔/积压工作}}\n==在本行之下进行测试==',
        summary: '重置用户沙盒',
        bot: true,
        tags: 'Bot'
    }, {
        retry: 500,
        noCache: true,
    });
});
