// 文件：index.js
require("dotenv").config();
const { env } = require('node:process')
console.log(env.DB_PASSWORD);
// 导入依赖
const { MediaWikiApi } = require('wiki-saikou')
 
// 初始化实例
const bot = new MediaWikiApi(env.zhapi)
 
// 登录账号
bot
  .login(env.BOT, env.BOTPASSWORD) // 在“创建您的 bot 账号”步骤中最后一步您得到的账号与密码信息
  // 我们用 then 方法等待登录的成功回调
  .then(() => {
    // 编辑页面，并返回操作结果
    return bot.postWithToken('csrf', {
      action: 'edit',
      title: 'U:穆斯塔法凯末尔/SandBox',
      text: '{{About|{{User|穆斯塔法凯末尔}}的沙盒|与其他用户共享的积压工作列表|User:穆斯塔法凯末尔/积压工作}}\n==在本行之下进行测试==',
      summary: '重置[[U:穆斯塔法凯末尔|穆斯塔法凯末尔]]的沙盒',
      bot: true, // 别忘了标记本次编辑为机器人编辑
      tags: 'Bot' // 别忘了添加合适的标签
    })
  })
  // 打印编辑操作的结果
  .then(console.log, console.error)