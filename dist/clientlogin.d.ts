import { MediaWikiApi } from 'wiki-saikou';
interface ClientLoginData {
    clientlogin: {
        status: string;
        message?: string;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}
declare function clientLogin(api: MediaWikiApi, username: string, password?: string, loginreturnurl?: string): Promise<ClientLoginData>;
export default clientLogin;
