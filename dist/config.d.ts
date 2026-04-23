interface BotConfig {
    name: string;
    password?: string;
    clientUsername?: string;
    clientPassword?: string;
}
interface WikiConfig {
    api: string;
    cookie?: string;
    bot: BotConfig;
}
interface Config {
    useragent?: string;
    password?: string;
    userAgent: string;
    zh: WikiConfig;
    cm: WikiConfig;
}
declare const config: Config;
export default config;
