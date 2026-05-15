async function fetchRedirectsForTemplate(api, templateName) {
    const aliases = [];
    let blcontinue;
    while (true) {
        const { data } = await api.post({
            action: 'query',
            list: 'backlinks',
            bltitle: templateName,
            blfilterredir: 'redirects',
            bllimit: 'max',
            blcontinue: blcontinue,
        }, { retry: 15 });
        const backlinks = data.query?.backlinks ?? [];
        for (const bl of backlinks) {
            aliases.push(bl.title);
        }
        if (data.continue?.blcontinue) {
            blcontinue = data.continue.blcontinue;
        }
        else {
            break;
        }
    }
    return aliases;
}
export async function buildTemplateNameMap(api, templateConfigs) {
    const map = new Map();
    for (const cfg of templateConfigs) {
        map.set(cfg.templateName, cfg);
    }
    const results = await Promise.all(templateConfigs.map(cfg => fetchRedirectsForTemplate(api, cfg.templateName)
        .then(aliases => ({ cfg, aliases }))));
    for (const { cfg, aliases } of results) {
        for (const alias of aliases) {
            map.set(alias, cfg);
        }
    }
    return map;
}
