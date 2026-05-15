export async function buildTemplateNameMap(api, templateConfigs) {
    const map = new Map();
    for (const cfg of templateConfigs) {
        map.set(cfg.templateName, cfg);
        let blcontinue;
        while (true) {
            const { data } = await api.post({
                action: 'query',
                list: 'backlinks',
                bltitle: cfg.templateName,
                blfilterredir: 'redirects',
                bllimit: 'max',
                blcontinue: blcontinue,
            }, { retry: 15 });
            const backlinks = data.query?.backlinks ?? [];
            for (const bl of backlinks) {
                map.set(bl.title, cfg);
            }
            if (data.continue?.blcontinue) {
                blcontinue = data.continue.blcontinue;
            }
            else {
                break;
            }
        }
    }
    return map;
}
