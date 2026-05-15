import type { MediaWikiApi } from 'wiki-saikou';

async function fetchRedirectsForTemplate(
	api: MediaWikiApi,
	templateName: string,
): Promise<string[]> {
	const aliases: string[] = [];
	let blcontinue: string | undefined;
	while (true) {
		const { data } = await api.post({
			action: 'query',
			list: 'backlinks',
			bltitle: templateName,
			blfilterredir: 'redirects',
			bllimit: 'max',
			blcontinue: blcontinue,
		}, { retry: 15 } as any) as any;

		const backlinks: Array<{ title: string }> = data.query?.backlinks ?? [];
		for (const bl of backlinks) {
			aliases.push(bl.title);
		}

		if (data.continue?.blcontinue) {
			blcontinue = data.continue.blcontinue;
		} else {
			break;
		}
	}
	return aliases;
}

export async function buildTemplateNameMap<T extends { templateName: string }>(
	api: MediaWikiApi,
	templateConfigs: T[],
): Promise<Map<string, T>> {
	const map = new Map<string, T>();

	for (const cfg of templateConfigs) {
		map.set(cfg.templateName, cfg);
	}

	const results = await Promise.all(
		templateConfigs.map(cfg =>
			fetchRedirectsForTemplate(api, cfg.templateName)
				.then(aliases => ({ cfg, aliases })),
		),
	);

	for (const { cfg, aliases } of results) {
		for (const alias of aliases) {
			map.set(alias, cfg);
		}
	}

	return map;
}
