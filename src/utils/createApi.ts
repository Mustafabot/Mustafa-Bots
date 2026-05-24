import { MediaWikiApi } from 'wiki-saikou';
import config from '../config.js';

export function createZhApi(): MediaWikiApi {
	return new MediaWikiApi({ baseURL: config.zh.api,
		fexiosConfigs: { 
				headers: { cookie: config.cm.cookie! }
			}
		}
		);
}

export function createCmApi(): MediaWikiApi {
	return new MediaWikiApi({ baseURL: config.zh.api,
		fexiosConfigs: { 
				headers: { cookie: config.cm.cookie! }
			}
		}
		);
}
