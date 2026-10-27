/**
 * SafetyPolicy:把"只操作公开网页"从一句口号变成可执行的代码。
 *
 * 对应 Stage 6 目标"会给浏览器操作加安全限制",实现三道防线:
 *   1. 域名白名单 —— 浏览器 agent 最危险之处是"能去任何网站",
 *      白名单从源头封死越权面(不登录敏感账号的前提是根本到不了登录站)。
 *   2. robots.txt —— 见 robots.ts:尊重站点明确的抓取规则,不绕过平台规则。
 *   3. 登录拦截 —— 见 tools.ts 的 browser_type:检测到密码框一律拒绝填写。
 *
 * 设计原则:安全检查返回"结构化结果 + 面向模型的解释",
 * 而不是直接抛异常 —— 被拦截也是给模型的信息,它应当据此调整计划,
 * 而错误信息同时会被 TraceLogger 记录下来供人审计。
 */

/** 判定结果:ok 时携带解析好的 URL;失败时携带给模型看的原因说明 */
export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

export class SafetyPolicy {
  /**
   * @param allowedDomains 小写的注册域名列表,如 ['example.com', 'iana.org']
   */
  constructor(private readonly allowedDomains: string[]) {}

  /**
   * 校验一个待访问的 URL 是否被允许。
   * 在 browser_navigate 执行任何网络请求之前调用(事前拦截)。
   */
  checkUrl(raw: string): UrlCheck {
    // new URL 在字符串不合法时抛异常:包一层 try 返回友好错误
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: `不是合法的 URL:"${raw}"。请给出完整 http(s) 地址。` };
    }

    // 只放行 http/https:file:// 能读本地文件,chrome:// 能碰浏览器内部,必须全部封死
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return {
        ok: false,
        reason: `安全策略:只允许 http/https 协议,已拒绝 ${url.protocol}// 地址。`,
      };
    }

    const host = url.hostname.toLowerCase();
    if (!this.isHostAllowed(host)) {
      return {
        ok: false,
        reason:
          `安全策略:域名 ${host} 不在允许列表内(仅允许:${this.allowedDomains.join(', ')})。` +
          `请不要访问列表外的任何站点,只应在允许的域名内完成任务。`,
      };
    }
    return { ok: true, url };
  }

  /**
   * 判断主机名是否在白名单内。
   * 匹配规则:精确相等,或是白名单域名的子域 ——
   * 用 endsWith('.' + domain) 而非 endsWith(domain),防止 evil-iana.org 伪装成 iana.org。
   */
  isHostAllowed(host: string): boolean {
    return this.allowedDomains.some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    );
  }
}
