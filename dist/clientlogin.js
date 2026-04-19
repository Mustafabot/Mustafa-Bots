import process from 'process';
import config from './config.js';
async function clientLogin(api, username, password = config.password, loginreturnurl = config.zh.api) {
    return api
        .postWithToken('login', {
        action: 'clientlogin',
        username: username,
        password: password,
        loginreturnurl,
    }, {
        tokenName: 'logintoken',
        retry: 15,
        noCache: true,
    })
        .then(({ data }) => {
        if (!data.clientlogin) {
            console.error('登录异常: 响应中缺少 clientlogin 数据', data);
            throw new Error('登录响应格式异常');
        }
        if (data.clientlogin.status === 'PASS') {
            console.log('登录成功', data);
            return data;
        }
        throw new Error(data.clientlogin.message);
    })
        .catch((err) => {
        console.error('登录异常', err);
        process.exit(1);
    });
}
export default clientLogin;
