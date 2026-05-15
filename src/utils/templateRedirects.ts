import type { MediaWikiApi } from 'wiki-saikou';

export async function buildTemplateNameMap<T extends { templateName: string }>(
	api: MediaWikiApi,
	templateConfigs: T[],
): Promise<Map<string, T>> {
	const map = new Map<string, T>();

	for (const cfg of templateConfigs) {
		map.set(cfg.templateName, cfg);

		let blcontinue: string | undefined;
		while (true) {
			const { data } = await api.post({
				action: 'query',
				list: 'backlinks',
				bltitle: cfg.templateName,
				blfilterredir: 'redirects',
				bllimit: 'max',
				blcontinue: blcontinue,
			}, { retry: 15 } as any) as any;

			const backlinks: Array<{ title: string }> = data.query?.backlinks ?? [];
			for (const bl of backlinks) {
				map.set(bl.title, cfg);
			}

			if (data.continue?.blcontinue) {
				blcontinue = data.continue.blcontinue;
			} else {
				break;
			}
		}
	}

	return map;
}
