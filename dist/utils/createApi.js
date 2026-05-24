import { MediaWikiApi } from 'wiki-saikou';
import config from '../config.js';
export function createZhApi() {
    return new MediaWikiApi({ baseURL: config.zh.api,
        fexiosConfigs: {
            headers: { cookie: config.cm.cookie }
        }
    });
}
export function createCmApi() {
    return new MediaWikiApi({ baseURL: config.zh.api,
        fexiosConfigs: {
            headers: { cookie: config.cm.cookie }
        }
    });
}
