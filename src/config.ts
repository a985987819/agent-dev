import 'dotenv/config';

// config.ts:集中管理所有可配置项。
// 为什么集中?配置散落在各模块里会导致"改一处要全局搜索",也难以测试;
// 集中后,所有模块只依赖这一个对象,"项目有哪些配置"一目了然。

/**
 * 必填环境变量缺失时立即报错并给出指引。
 * 为什么在读取时就报错:配置问题越早暴露越好,
 * 等到模型请求 401 才发现 Key 没配,排查成本高得多。
 */
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `缺少环境变量 ${name}:请复制 .env.example 为 .env,并按注释填写模型配置` +
        `(支持 DeepSeek / 通义千问 / 智谱 / Kimi / OpenAI 等任何 OpenAI 兼容接口)。`,
    );
  }
  return value;
}

/**
 * 白名单默认值:全部是公开演示站点(两个是专供爬虫练习的沙盒站),
 * 保证仓库 clone 下来、不配置任何东西也能安全跑通。
 */
const DEFAULT_ALLOWED_DOMAINS =
  'example.com,iana.org,quotes.toscrape.com,books.toscrape.com';

export const config = {
  // ---- 模型配置用 getter 惰性读取 ----
  // 为什么惰性:smoke.ts 冒烟测试不调用模型,若 import 时就强校验,
  // 没有 .env 的用户连冒烟测试都跑不了。getter 让"用不到就不报错"。

  /** OpenAI 兼容接口地址,例如 https://api.deepseek.com/v1 */
  get baseURL(): string {
    return requiredEnv('AI_BASE_URL');
  },
  /** 对应平台的 API Key(只存在于本地 .env,绝不入库) */
  get apiKey(): string {
    return requiredEnv('AI_API_KEY');
  },
  /** 模型 ID,例如 deepseek-chat / qwen-plus / glm-4.6 */
  get model(): string {
    return requiredEnv('AI_MODEL');
  },

  // ---- 以下配置有安全默认值,直接 eager 读取 ----

  /**
   * 允许浏览器访问的域名白名单(逗号分隔的小写注册域名)。
   * 匹配规则:精确相等,或是其子域(如 iana.org 能匹配 www.iana.org)。
   */
  allowedDomains: (process.env.ALLOWED_DOMAINS ?? DEFAULT_ALLOWED_DOMAINS)
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),

  /**
   * 是否无头模式运行浏览器。
   * 默认 true(服务器/CI 没有显示器);本机调试设为 false 可肉眼观察操作过程。
   */
  headless: process.env.HEADLESS !== 'false',

  /** 痕迹(截图/日志/报告)的输出根目录 */
  traceDir: 'traces',
};
