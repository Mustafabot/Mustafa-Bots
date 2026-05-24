import { MediaWikiApi } from 'wiki-saikou';
import config from '../config.js';

export function createZhApi(): MediaWikiApi {
	return new MediaWikiApi({ baseURL: config.zh.api,
		fexiosConfigs: { 
				headers: { 'user-agent': config.userAgent+`(Github Actions; Mustafa-bot)` }
			}
		}
		);
}

export function createCmApi(): MediaWikiApi {
	return new MediaWikiApi({ baseURL: config.cm.api,
		fexiosConfigs: { 
			headers: { 'user-agent': config.userAgent+`(Github Actions; Mustafa-bot)` }
			}
		}
		);
}
