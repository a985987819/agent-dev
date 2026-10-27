import type { APIRequestContext } from 'playwright';

/**
 * RobotsChecker:极简 robots.txt 检查,落实 Stage 6 目标"不绕过平台规则"。
 *
 * robots.txt 是站点对爬虫/自动化访问的公开声明(https://www.robotstxt.org/)。
 * 合规的浏览器 agent 应当遵守它 —— 这也是面试中"你的 agent 如何合规"的标准答案点。
 *
 * 实现取舍(刻意保持"简单",但边界都说清楚):
 * - 只解析 `User-agent: *` 组的 Allow/Disallow 规则,即"对所有爬虫生效"的组;
 *   我们不是搜索引擎,不需要精细的 UA 匹配。
 * - 前缀匹配 + 最长前缀优先(与 Google robots 规范一致的主流做法),
 *   不支持 * 和 $ 通配符 —— 演示项目里宁可保守报错,也不做错误放行。
 * - 抓取失败按"允许"处理(fail-open)并记录日志:robots 检查不应成为整个
 *   任务的单点故障;若你的场景要求更严格,可改为 fail-closed(一行判断的事)。
 * - 每个站点只抓取并解析一次,结果缓存复用,避免每个动作都多发一次请求。
 */

interface RobotsRules {
  allow: string[];
  disallow: string[];
}

export class RobotsChecker {
  /** origin -> 解析结果;null 表示"没有 robots.txt 或抓取失败",即不限制 */
  private cache = new Map<string, RobotsRules | null>();

  constructor(
    /**
     * 用 Playwright 的 APIRequestContext(而非全局 fetch)发请求:
     * 复用浏览器上下文的 UA 与网络栈,让站点看到的是同一个访客。
     */
    private readonly request: APIRequestContext,
    /** 日志回调:把 robots 相关的决定写入痕迹,便于复盘"为什么没访问" */
    private readonly log: (summary: string) => void,
  ) {}

  /** 判断某个 URL 是否被该站点的 robots.txt 允许 */
  async isAllowed(url: URL): Promise<{ allowed: boolean; reason?: string }> {
    const rules = await this.getRules(url.origin);
    if (!rules) return { allowed: true };

    // 参与匹配的路径 = 路径名 + 查询串(robots 规则作用于此)
    const path = url.pathname + url.search;

    // 在所有命中的规则里选前缀最长的;Allow 与 Disallow 打平(等长)时取 Allow,
    // 这是 Google 规范的裁决方式,能正确处理"允许某个子目录、禁掉整个上级"的常见配置
    let best: { kind: 'allow' | 'disallow'; len: number } | null = null;
    for (const prefix of rules.disallow) {
      if (prefix && path.startsWith(prefix) && (!best || prefix.length > best.len)) {
        best = { kind: 'disallow', len: prefix.length };
      }
    }
    for (const prefix of rules.allow) {
      if (prefix && path.startsWith(prefix) && (!best || prefix.length >= best.len)) {
        best = { kind: 'allow', len: prefix.length };
      }
    }

    if (best?.kind === 'disallow') {
      const reason =
        `robots.txt 规则:站点 ${url.origin} 禁止抓取 ${path}。` +
        `请遵守该站点声明,尝试其他允许的页面,或改用站点提供的开放接口。`;
      this.log(`robots.txt 拦截:${url.href}`);
      return { allowed: false, reason };
    }
    return { allowed: true };
  }

  /** 拉取并解析某 origin 的 robots.txt(带缓存) */
  private async getRules(origin: string): Promise<RobotsRules | null> {
    const cached = this.cache.get(origin);
    if (cached !== undefined) return cached;

    let rules: RobotsRules | null = null;
    try {
      const res = await this.request.get(`${origin}/robots.txt`, { timeout: 5_000 });
      // 404/5xx 都视为"无有效 robots.txt":规范约定如此(404 = 不限制)
      if (res.ok()) {
        rules = this.parse(await res.text());
        this.log(`已加载 ${origin}/robots.txt(Disallow ${rules.disallow.length} 条)`);
      }
    } catch (err) {
      // fail-open:网络抖动不该让整个任务失败,但要留下记录供人知晓
      this.log(`robots.txt 获取失败(${(err as Error).message}),按允许处理`);
    }
    this.cache.set(origin, rules);
    return rules;
  }

  /** 解析 robots.txt 文本:只关心 User-agent: * 组的 Allow / Disallow */
  private parse(text: string): RobotsRules {
    const rules: RobotsRules = { allow: [], disallow: [] };
    // 当前行是否属于 User-agent: * 组:robots 的"组"由连续的指令行构成,
    // 遇到新的 user-agent 行就切换上下文
    let inStarGroup = false;

    for (const rawLine of text.split(/\r?\n/)) {
      // 去掉注释(# 之后)与首尾空白
      const line = rawLine.split('#')[0]!.trim();
      if (!line) continue;

      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const field = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();

      if (field === 'user-agent') {
        inStarGroup = value === '*';
      } else if (inStarGroup && field === 'allow' && value) {
        rules.allow.push(value);
      } else if (inStarGroup && field === 'disallow' && value) {
        // "Disallow:"(空值)表示"不禁止任何路径",跳过空值即等价实现
        rules.disallow.push(value);
      }
    }
    return rules;
  }
}
