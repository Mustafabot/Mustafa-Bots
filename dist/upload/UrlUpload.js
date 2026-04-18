import { MediaWikiApi } from 'wiki-saikou';
import { URL } from 'url';
import config from '../config.js';
import clientlogin from '../clientlogin.js';
const zhApi = new MediaWikiApi(config.zh.api, {
    headers: { cookie: config.zh.cookie },
});
const cmApi = new MediaWikiApi(config.cm.api, {
    headers: { cookie: config.cm.cookie },
});
const MAX_RETRIES = 3;
const DEFAULT_COMMENT = '机器人：自其他网站迁移文件';
const CONFIG_PAGE = 'User:没有羽翼的格雷塔/BotConfig/UrlUpload.json';
async function fetchJsonConfig(api, pageTitle) {
    const { data } = await api.post({
        action: 'query',
        prop: 'revisions',
        rvprop: 'content',
        titles: pageTitle,
    }, {
        retry: 15,
    });
    const pages = data.query.pages;
    const page = Object.values(pages)[0];
    if (!page || !page.revisions) {
        throw new Error(`配置页面 "${pageTitle}" 不存在或无法获取内容`);
    }
    const content = page.revisions[0].content;
    try {
        return JSON.parse(content);
    }
    catch (e) {
        throw new Error(`JSON解析失败: ${e.message}`, { cause: e });
    }
}
function validateConfig(uploadConfig) {
    const errors = [];
    if (!uploadConfig || typeof uploadConfig !== 'object') {
        errors.push('配置必须是一个对象');
        return { valid: false, errors };
    }
    if (!Array.isArray(uploadConfig.files) || uploadConfig.files.length === 0) {
        errors.push('files必须是非空数组');
        return { valid: false, errors };
    }
    const hasMissingFilename = uploadConfig.files.some(f => !f.filename);
    if (hasMissingFilename && !uploadConfig.article) {
        errors.push('当filename未指定时，article为必填项');
    }
    uploadConfig.files.forEach((file, index) => {
        if (!file.url) {
            errors.push(`files[${index}]: url为必填项`);
        }
        else {
            try {
                const url = new URL(file.url);
                if (!['http:', 'https:'].includes(url.protocol)) {
                    errors.push(`files[${index}]: URL协议必须是http或https`);
                }
            }
            catch {
                errors.push(`files[${index}]: URL格式无效`);
            }
        }
    });
    return {
        valid: errors.length === 0,
        errors,
    };
}
function extractExtension(url) {
    try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
        return match ? `.${match[1]}` : '';
    }
    catch {
        return '';
    }
}
function generateFilename(url, article, index) {
    const ext = extractExtension(url);
    return `File:${article} ${index}${ext}`;
}
async function uploadFromUrl(api, fileConfig, globalConfig, index, dryRun, article) {
    const filename = fileConfig.filename || generateFilename(fileConfig.url, article ?? '', index);
    const comment = globalConfig.comment || DEFAULT_COMMENT;
    const text = globalConfig.text || `{{Copyright}}[[Category:${article}]][[Category:迁移文件]]`;
    console.log(`  来源URL: ${fileConfig.url}`);
    if (dryRun) {
        console.log('  [试运行模式] 跳过实际上传');
        return {
            filename,
            url: fileConfig.url,
            success: true,
        };
    }
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const { data } = await api.postWithToken('csrf', {
                action: 'upload',
                filename,
                url: fileConfig.url,
                comment,
                text,
                ignorewarnings: true,
                bot: true,
                tags: 'Bot',
                watchlist: 'nochange',
            }, {
                retry: 500,
                noCache: true,
            });
            if (data.upload && data.upload.result === 'Success') {
                if (data.upload.warnings) {
                    console.log('  警告: 文件已存在，已被覆盖');
                }
                return {
                    filename,
                    url: fileConfig.url,
                    success: true,
                };
            }
            else {
                throw new Error(JSON.stringify(data));
            }
        }
        catch (error) {
            const errMessage = error.message;
            if (errMessage && errMessage.includes('moderation-image-queued')) {
                console.log('  文件已进入审核队列');
                return {
                    filename,
                    url: fileConfig.url,
                    success: true,
                };
            }
            lastError = error;
            if (attempt < MAX_RETRIES) {
                console.log(`  上传失败（${errMessage}），第${attempt}次重试...`);
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }
        }
    }
    return {
        filename,
        url: fileConfig.url,
        success: false,
        error: lastError?.message || '未知错误',
    };
}
async function batchUpload(api, uploadConfig, dryRun) {
    const results = [];
    const total = uploadConfig.files.length;
    for (let i = 0; i < total; i++) {
        const fileConfig = uploadConfig.files[i];
        const index = i + 1;
        console.log(`\n[${index}/${total}] 正在上传: ${fileConfig.filename || '(自动生成)'}`);
        const result = await uploadFromUrl(api, fileConfig, uploadConfig, index, dryRun, uploadConfig.article);
        results.push(result);
        if (result.success) {
            console.log('  上传成功！');
        }
        else {
            console.error(`  上传失败: ${result.error}`);
        }
    }
    return results;
}
function parseArgs(args) {
    const result = {
        dryRun: false,
        verbose: false,
    };
    for (const arg of args) {
        if (arg === '--dry-run') {
            result.dryRun = true;
        }
        else if (arg === '--verbose') {
            result.verbose = true;
        }
    }
    return result;
}
async function main() {
    console.log(`Start time: ${new Date().toISOString()}`);
    const args = parseArgs(process.argv.slice(2));
    console.log('正在登录zh站...');
    await clientlogin(zhApi, config.zh.bot.clientUsername, config.zh.bot.clientPassword)
        .then((result) => { console.log('zh站登录成功', result); });
    console.log('正在登录commons站...');
    await clientlogin(cmApi, config.cm.bot.clientUsername, config.cm.bot.clientPassword, config.cm.api)
        .then((result) => { console.log('commons站登录成功', result); });
    console.log(`\n正在读取配置文件: ${CONFIG_PAGE}`);
    let uploadConfig;
    try {
        uploadConfig = await fetchJsonConfig(zhApi, CONFIG_PAGE);
    }
    catch (error) {
        console.error(`读取配置失败: ${error.message}`);
        process.exit(1);
    }
    console.log('正在验证配置...');
    const validation = validateConfig(uploadConfig);
    if (!validation.valid) {
        console.error('配置验证失败:');
        validation.errors.forEach(err => console.error(`  - ${err}`));
        process.exit(1);
    }
    console.log(`配置文件解析成功，共 ${uploadConfig.files.length} 个文件待上传`);
    if (args.dryRun) {
        console.log('\n[试运行模式] 不会实际上传文件');
    }
    const results = await batchUpload(cmApi, uploadConfig, args.dryRun);
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    console.log('\n上传完成！');
    console.log(`成功: ${successCount} 个`);
    console.log(`失败: ${failCount} 个`);
    if (failCount > 0 && args.verbose) {
        console.log('\n失败详情:');
        results.filter(r => !r.success).forEach(r => {
            console.log(`  - ${r.filename}: ${r.error}`);
        });
    }
    console.log(`\nEnd time: ${new Date().toISOString()}`);
}
main().catch((error) => {
    console.error('发生错误:', error);
    process.exit(1);
});
