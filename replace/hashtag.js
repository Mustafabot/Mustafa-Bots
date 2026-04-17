import { MediaWikiApi } from 'wiki-saikou';
import Parser from 'wikiparser-node';
import config from '../config.js';
import clientlogin from '../clientlogin.js';

const api = new MediaWikiApi(config.zh.api, {
	headers: { cookie: config.zh.cookie },
});

(async () => {
	console.log(`Start time: ${new Date().toISOString()}`);
	
	await clientlogin(api, config.zh.bot.clientUsername, config.zh.bot.clientPassword)
		.then((result) => { console.log(result); });

	const pages = await (async () => {
		const result = [];
		const eol = Symbol();
		let geicontinue = undefined;
		while (geicontinue !== eol) {
			const { data } = await api.post({
                action: 'query',
				prop: 'revisions',
				generator: 'embeddedin',
				rvprop: 'content',
				geititle: 'Template:Hashtags',
				geinamespace: '0',
				geilimit: '50',
				geicontinue,
			}, {
				retry: 15,
			});
			geicontinue = data.continue ? data.continue.geicontinue : eol;
            await new Promise(resolve => setTimeout(resolve, 1000));
            console.log(`geicontinue: ${geicontinue === eol ? 'END_OF_LIST' : geicontinue}`);
			result.push(...Object.values(data.query.pages).filter((page) => page.revisions));
		}
        console.log(`Total pages: ${result.length}`);
		return result;
	})();

	for (const page of pages) {
		const { title, revisions: [{ content }] } = page;
		console.log(`处理 ${title} 中！`);

		const parser = Parser.parse(content);
		/** @type {Parser.TranscludeToken[]} */
		const templates = parser.querySelectorAll('template#Template:Hashtags');
		if (templates.length === 0) {
			continue;
		}
		let summary = '测试替换{{[[T:Hashtags|Hashtags]]}}用法';
        let index = 1;
		for (const temp of templates) {
			for (const arg of temp.getAllArgs()) {
				arg.escape();
                if (/^(type)$/.test(arg.name)&&arg.value==='bilibilinew') {
                    continue;
                }
				if (!/^(type|tag\d+|use\d+|id\d+|lang|sepr|class|css)$/.test(arg.name)) {
                    temp.setValue(`tag${index}`, arg.name);
                    temp.setValue(`use${index}`, arg.value);
					temp.removeArg(arg.name);
                    index++;
				}
			}
		}

		const newContent = parser.toString();
		
		// 检查内容是否发生变化
		if (newContent === content) {
			console.log(`${title}: 内容无变化，跳过提交`);
			continue;
		}

		console.log(`${title}: 检测到变更，准备提交`);
		
		await api.postWithEditToken({
			action: 'edit',
			title,
			text: newContent,
			summary,
			bot: true,
			notminor: true,
			tags: 'Bot',
			watchlist: 'nochange',
		}).then(({ data }) => console.log(JSON.stringify(data)));
	}

	console.log(`End time: ${new Date().toISOString()}`);
})();