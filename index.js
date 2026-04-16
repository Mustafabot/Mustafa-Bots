// 文件：index.js
import { MediaWikiApi } from 'wiki-saikou';
//import Parser from 'wikiparser-node';
import config from './config.js';
import clientlogin from './clientlogin.js';
 
/** @type {import('wiki-saikou').MediaWikiApi} */
const bot = new MediaWikiApi(config.zh.api, {
	headers: { cookie: config.useragent },
});
 
// 登录账号
await clientlogin(bot, config.zh.bot.clientUsername, config.zh.bot.clientPassword)
  .then((result) => { console.log(result); }) // 在“创建您的 bot 账号”步骤中最后一步您得到的账号与密码信息
  // 我们用 then 方法等待登录的成功回调
  .then(() => {
    // 编辑页面，并返回操作结果
    return bot.postWithToken('csrf',{
      action: 'edit',
      title: 'User:没有羽翼的格雷塔/SandBox',
      text: '{{About|{{User|没有羽翼的格雷塔}}的沙盒|与其他用户共享的积压工作列表|User:没有羽翼的格雷塔/积压工作}}\n==在本行之下进行测试==',
      summary: '重置用户沙盒',
      bot: true, // 别忘了标记本次编辑为机器人编辑
      tags: 'Bot' // 别忘了添加合适的标签
    },{
      retry: 500,
      noCache: true,
    });
  })
  //.then((result) => { console.log(result); })
  // 打印编辑操作的结果
  //.then(console.log, console.error)