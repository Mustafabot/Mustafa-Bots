import type { MediaWikiApi } from 'wiki-saikou';
export declare function buildTemplateNameMap<T extends {
    templateName: string;
}>(api: MediaWikiApi, templateConfigs: T[]): Promise<Map<string, T>>;
