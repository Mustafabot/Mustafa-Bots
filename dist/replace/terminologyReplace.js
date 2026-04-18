import { MediaWikiApi } from 'wiki-saikou';
import config from '../config.js';
import clientlogin from '../clientlogin.js';
const api = new MediaWikiApi(config.zh.api, {
    headers: { cookie: config.zh.cookie },
});
const PAGE_TITLES = [
    "尤里·布莱尔",
    "由里乌斯·尤克历乌斯",
    "猿飞阿斯玛",
    "月咏(银魂)",
    "葬送的芙莉莲",
    "正一",
    "志村团藏",
    "中须贺艾米",
    "最强会长黑神",
    "Mr.Quin"
];
const REPLACEMENT_RULES = [
    {
        name: '陆/陸替换',
        pattern: /（[陆陸]((?!地).*?)）/g,
        replacement: '（汉语$1）',
    },
    {
        name: '台替换',
        pattern: /（[台臺]((?![角版湾灣配语語]).*?)）/g,
        replacement: '（汉语，中国台湾$1）',
    },
    {
        name: '台语替换',
        pattern: /（[台臺](?=[语語].*?)）/g,
        replacement: '（台湾闽南语$1）',
    },
    {
        name: '日替换',
        pattern: /（日((?![语語文本萌式]).*?)）/g,
        replacement: '（日语$1）',
    },
    {
        name: '港替换',
        pattern: /（港((?!口).*?)）/g,
        replacement: '（汉语，中国香港$1）',
    },
];
function applyReplacements(content) {
    let result = content;
    const changeLog = [];
    for (const rule of REPLACEMENT_RULES) {
        const matches = result.match(rule.pattern);
        if (matches && matches.length > 0) {
            changeLog.push({
                rule: rule.name,
                matches: matches,
                count: matches.length,
            });
            result = result.replace(rule.pattern, rule.replacement);
        }
    }
    return { newContent: result, changeLog };
}
async function processPage(title) {
    console.log(`\n========== 处理页面: ${title} ==========`);
    try {
        console.log(`正在获取页面内容...`);
        const { data } = await api.post({
            action: 'query',
            prop: 'revisions',
            titles: title,
            rvprop: 'content',
        }, {
            retry: 15,
        });
        const pages = Object.values(data.query.pages);
        if (!pages[0] || !pages[0].revisions) {
            console.error(`页面 "${title}" 不存在或无法获取内容`);
            return false;
        }
        const originalContent = pages[0].revisions[0].content;
        console.log(`成功获取页面内容，长度: ${originalContent.length} 字符`);
        console.log('开始执行正则替换...');
        const { newContent, changeLog } = applyReplacements(originalContent);
        if (changeLog.length === 0) {
            console.log('未发现需要替换的内容，跳过保存操作');
            return false;
        }
        console.log('替换统计:');
        for (const log of changeLog) {
            console.log(`  - ${log.rule}: ${log.count} 处`);
            console.log(`    匹配项: ${JSON.stringify(log.matches)}`);
        }
        if (newContent === originalContent) {
            console.log('替换后内容与原内容相同，跳过保存操作');
            return false;
        }
        console.log('正在保存页面...');
        const summary = '机器人：替换历史遗留地区用语';
        await api.postWithEditToken({
            action: 'edit',
            title,
            text: newContent,
            summary,
            bot: true,
            minor: true,
            tags: 'Bot',
            watchlist: 'nochange',
        }).then(({ data }) => {
            console.log('保存成功！');
            console.log(JSON.stringify(data));
        });
        return true;
    }
    catch (error) {
        console.error(`处理页面 "${title}" 时发生错误:`);
        if (error instanceof Error) {
            console.error(`错误类型: ${error.name}`);
            console.error(`错误信息: ${error.message}`);
            if (error.stack) {
                console.error(`错误堆栈: ${error.stack}`);
            }
        }
        return false;
    }
}
(async () => {
    console.log(`Start time: ${new Date().toISOString()}`);
    try {
        console.log('正在登录...');
        await clientlogin(api, config.zh.bot.clientUsername, config.zh.bot.clientPassword)
            .then((result) => { console.log(result); });
        let successCount = 0;
        let skipCount = 0;
        for (const title of PAGE_TITLES) {
            const result = await processPage(title);
            if (result === true) {
                successCount++;
            }
            else {
                skipCount++;
            }
        }
        console.log('\n========== 批量处理完成 ==========');
        console.log(`总计: ${PAGE_TITLES.length} 个页面`);
        console.log(`成功修改: ${successCount} 个`);
        console.log(`跳过/无变化: ${skipCount} 个`);
    }
    catch (error) {
        console.error('发生错误:');
        if (error instanceof Error) {
            console.error(`错误类型: ${error.name}`);
            console.error(`错误信息: ${error.message}`);
            if (error.stack) {
                console.error(`错误堆栈: ${error.stack}`);
            }
        }
        process.exit(1);
    }
    console.log(`End time: ${new Date().toISOString()}`);
})();
