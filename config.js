// config.js

import path from 'path';
import { fileURLToPath } from 'url';

// --- ES Module 环境下的 __dirname ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * @description 应用程序的核心配置对象
 */
const CONFIG = {
    // 任务定义
    taskDescription: '为中国大陆的读者提供一份关于国家重要新闻的每日简报。',
    startUrl: 'http://www.xinhuanet.com/',

    // 调试与输出
    debugMode: false, // 设置为 true 可在控制台看到详细的 LLM 请求日志
    outputBaseDir: path.join(__dirname, 'output'),

    // 网络相关
    network: {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        },
        fetchTimeout: 20000, // 页面抓取超时时间 (ms)
    },

    // 爬取与链接筛选
    crawling: {
        maxDepth: 2, // 爬取最大深度
        maxCategoriesToExplore: 12, // (新) 在每个深度，从识别出的栏目中，选出最重要的N个进行下一步探索
        categoryRankingGroupSize: 10, // (新) 栏目排名时，每组比较的栏目数量
        categoryRankingPoints: [5, 3, 2, 1, 0], // (新) 栏目排名得分
        uselessTitleKeywords: ['关于我们', '联系我们', '隐私政策', '登录', '注册', '下载', '更多', '广告', '订阅'],
    },

    // 锦标赛排名配置
    ranking: {
        // --- 资格赛配置 (已更新) ---
        qualificationRounds: 2,         // (新) 资格赛进行轮次，实现更公平的筛选
        qualificationGroupSize: 10,     // 资格赛中，每组比较多少个链接标题
        qualificationTopN: 3,           // (行为变更) 多轮后，仅用于最终选择，不再是每组淘汰
        qualificationPoints: [5, 3, 2, 1, 0], // (新) 资格赛小组得分
        qualificationConcurrency: 10,   // 资格赛并发请求数

        // --- 聚类配置 ---
        groupingBatchSize: 20, // 每次聚类时，LLM处理的新文章数量

        // --- 决赛圈配置 ---
        contendersToRank: 60,       // 最多选出多少位“选手”进入决赛圈
        tournamentRounds: 3,        // 进行多少轮决赛
        tournamentGroupSize: 3,     // 决赛每轮比较中，每组包含多少篇文章
        tournamentPoints: [3, 1, 0], // 决赛小组前三名得分
        tournamentConcurrency: 8,   // 决赛并发请求数
    },

    // 文章处理
    processing: {
        maxArticlesToProcess: 15, // 最终处理的文章数量上限
        minContentLength: 60, // 认为文章有效的最小内容长度（字符）
        maxOverallRetries: 5, // 针对失败队列的整体最大重试轮次，防止无限循环
    },

    // 大语言模型 (LLM)
    llm: {
        studioUrl: 'http://localhost:1234/v1/chat/completions',
        maxRetries: 1, // 单次处理失败后不再立即重试，交由失败队列统一管理
        retryDelay: 1000, // 每次重试的延迟时间 (ms)
        requestTimeout: 120000, // 普通LLM请求超时时间 (ms)
        longRequestTimeout: 300000, // 长任务LLM请求超时时间 (ms)
        maxTokens: 999999, // LLM返回的最大token数
    },

    // 输出格式化
    output: {
        categoryEmojis: { '国际': '🌍', '国内': '🇨🇳', '财经': '💼', '科技': '🔬', '社会': '👥', '观点': '✍️', '其他': '📰', '默认': '📰' }
    },

    // Prompt 模板中心
    prompts: {
        qualifyLinks: (linkTitles, taskDescription) => ({
            system: '你是一位反应迅速、判断精准的新闻编辑，任务是快速判断在一组新闻标题中，哪些对目标读者最重要。你的回应必须极端简洁，严格遵循格式。内容使用简体中文。',
            user: `**任务目标**: “${taskDescription}”\n\n**待评估的标题列表**:\n${linkTitles.map((title, i) => `${i + 1}. ${title}`).join('\n')}\n\n**你的指令**:\n根据任务目标，对列表中的标题进行重要性排序。你的回应【只能】是标题的【编号】，从最重要到最不重要排列，并用英文逗号 (,) 分隔。不要包含任何理由、解释或多余的文字。\n\n**格式示例**: 3,1,2,5,4\n\n**你的回应**:`,
        }),

        rankCategories: (categoryTitles, taskDescription) => ({
            system: '你是一位经验丰富的新闻网站总编辑，任务是判断在一组“新闻栏目”中，哪些对于目标读者来说最有可能包含重要新闻,比较好的栏目名类似于[财经][科技][国际][亚洲新闻]这种,不好的栏目名类似于[中国政府网][公司官网][联系我们]这种。你的回应必须极端简洁，严格遵循格式。内容使用简体中文。',
            user: `**任务目标**: “${taskDescription}”\n\n**待评估的“栏目”标题列表**:\n${categoryTitles.map((title, i) => `${i + 1}. ${title}`).join('\n')}\n\n**你的指令**:\n根据任务目标，对列表中的栏目标题进行重要性排序。你的回应【只能】是栏目的【编号】，从最重要到最不重要排列，并用英文逗号 (,) 分隔。不要包含任何理由、解释或多余的文字。\n\n**格式示例**: 3,1,2,5,4\n\n**你的回应**:`,
        }),
        
        classifyLinkType: (linkTitle) => ({
            system: '你是一个链接分类工具，任务是判断一个链接标题指向的是“文章页面”还是“栏目列表页面”。你的回应必须是单个词。内容使用简体中文。',
            user: `请判断以下链接标题更可能是一个具体的新闻“文章”（article）还是一个新闻“栏目”（category）。\n标题：“${linkTitle}”\n\n你的回应只能是 "article" 或 "category"。\n\n回应:`,
        }),
        
        groupArticlesBySimilarity: (representatives, candidates) => ({
            system: '你是一个高度精准的新闻聚类引擎。你的任务是判断一批新文章的标题是否与已有的新闻主题（由代表标题表示）在核心事件上相同。你的回应必须是一个纯粹的、格式完美的JSON对象。内容使用简体中文。',
            user: `
**任务**: 将“待分类文章”列表中的每一篇文章，与“已有主题”列表进行匹配。

**已有主题 (代表标题)**:
${representatives.map((rep, i) => `${i + 1}. "${rep.title}"`).join('\n')}

**待分类文章**:
${candidates.map((cand, i) => `A${i}. "${cand.title}"`).join('\n')}

**你的指令**:
仔细阅读每个“待分类文章”的标题，判断它报道的核心事件是否与某个“已有主题”完全一致。
- 如果是，请将它归类到对应的“已有主题”的【编号】下。
- 如果它是一个全新的、独立的新闻事件，请将其归类为【0】。

你的回应【必须且只能】是一个JSON对象，其中key是待分类文章的ID (例如 "A0", "A1", ...)，value是它归属的主题编号或0。

**格式示例**:
{
  "A0": 1,
  "A1": 0,
  "A2": 1,
  "A3": 2
}

**请严格遵照以上所有规则，开始生成你的JSON对象：**
`
        }),

        // <-- 新增的 Prompt 用于生成议题 -->
        generateClusterTheme: (titles) => ({
            system: '你是一位顶级的议题分析师，擅长从一组相似的新闻标题中，提炼出最核心、最精炼的议题名称。你的回应必须极端简洁。内容使用简体中文。',
            user: `**任务**: 根据以下新闻标题列表，生成一个不超过15个字的、高度概括的“议题名称”。

**新闻标题列表**:
${titles.map(title => `- "${title}"`).join('\n')}

**你的指令**:
分析以上所有标题，总结它们共同报道的核心事件，并给出一个简短的议题名称。你的回应【只能】是议题名称本身，不能包含任何引号、解释或其他文字。

**格式示例**: 俄乌冲突新一轮谈判
**你的回应**:`,
        }),

        // <-- 新增的 Prompt 用于验证议题一致性 -->
        verifyClusterConsistency: (theme, titles) => ({
            system: '你是一个严谨的内容审核员，负责检验一组新闻标题是否都严格符合给定的核心议题。你的回应必须极端简洁，严格遵循格式。内容使用简体中文。',
            user: `**核心议题**: "${theme}"

**待检验的新闻标题列表**:
${titles.map((title, i) => `${i + 1}. "${title}"`).join('\n')}

**你的指令**:
判断列表中的每一个标题，是否与“核心议题”报道的是同一件事。
你的回应【只能】是【不符合】议题的标题的【编号】，用英文逗号 (,) 分隔。
如果所有标题都符合议题，请回应 "none"。

**格式示例 1 (有不符合的)**: 3,5
**格式示例 2 (全部符合)**: none

**你的回应**:`,
        }),

        rankContenders: (articles, taskDescription) => ({
            system: '你是一位顶级的、拥有宏观视野的总编辑，任务是判断在一组新闻中，哪些对于目标读者最重要、最具有新闻价值。你的判断必须果断、精准，且严格遵循输出格式。内容使用简体中文。',
            user: `**任务目标**: “${taskDescription}”\n\n**待排名新闻列表**:\n${articles.map((a, i) => `${i + 1}. ${a.title}`).join('\n')}\n\n**你的指令**:\n请根据上述任务目标，对列表中的新闻进行重要性排序。你的回应【只能】是新闻的【编号】，从最重要到最不重要排列，并用英文逗号 (,) 分隔。不要包含任何理由、解释或多余的文字。\n\n**格式示例**: 3,1,2\n\n**你的回应**:`,
        }),
        
         processArticleSingleCall: (articleContent, originalTitle) => ({
            system: '你是一个高度专业化的信息提取和处理API。你的唯一功能是接收文本，并根据用户指定的结构，返回一个【纯粹的、格式完美的JSON对象】。你的输出严禁包含任何JSON之外的文本、解释或Markdown标记（如```json）。内容使用简体中文。',
            user: `
**新闻原文全文**:
---
${articleContent}
---

**你的任务**:
根据以上原文，执行下列所有指令，并生成一个【单一、完整、无任何多余内容】的JSON对象回复。

**# JSON对象结构定义**
你必须生成一个包含以下key的JSON对象：
1.  \`"title"\`: (string) 生成一个全新的、精炼、中立、信息量大的中文标题。
2.  \`"conciseSummary"\`: (string) 用一句话（不超过60字）高度凝练其核心内容。
3.  \`"keywords"\`: (string[]) 提取3-5个最重要的核心关键词，并存为一个JSON字符串数组。
4.  \`"category"\`: (string) 从 ['国际', '国内', '财经', '科技', '社会', '观点', '其他'] 中选择一个最匹配的分类。
5.  \`"detailedSummary"\`: (string) 撰写一篇详尽、流畅、结构清晰的深度摘要（约200-800字）,如果原文文章比较长,字数也可以适度增加,如果原文存在时间,地点,人物(主体),事件这些重要信息,一定要包含进去(无需格式化说明时间地点人物事件)，可使用Markdown换行符 \`\\n\` 和列表来增强可读性。

**# 绝对规则 (!!!必须严格遵守!!!)**
1.  **【规则1：纯净JSON】** 你的整个回复【必须且只能】是一个完整的JSON对象，从 \`{\` 开始，到 \`}\` 结束。
2.  **【规则2：无外部文本】** 严禁在JSON对象前后添加任何文本、注释、或Markdown代码块标记。

---
**# 格式示例 (请严格模仿此JSON结构)**

\`\`\`json
{
  "title": "俄乌冲突升级：基辅遭遇大规模空袭，平民伤亡引发国际谴责",
  "conciseSummary": "俄罗斯对乌克兰首都基辅发动新一轮大规模空袭，导致多栋民用建筑受损和大量平民伤亡，引发国际社会强烈谴责和对人道危机的担忧。",
  "keywords": ["俄乌冲突", "基辅", "空袭", "人道危机", "国际谴责"],
  "category": "国际",
  "detailedSummary": "俄罗斯军队于周四凌晨对乌克兰首都基辅发动了数月来最大规模的空袭之一。乌克兰军方表示，防空系统拦截了大部分来袭的导弹和无人机，但仍有部分袭击造成了严重后果。\\n\\n**主要影响包括：**\\n* **人员伤亡**: 市长报告称，至少有10名平民在袭击中丧生，超过50人受伤。救援工作仍在进行中。\\n* **基础设施破坏**: 一栋居民楼被直接击中，引发大火。一个关键的能源设施也遭到破坏。\\n\\n国际社会迅速对此事做出反应。美国总统谴责此次袭击是“野蛮行径”，联合国秘书长也呼吁立即停止针对平民的袭击。"
}
\`\`\`
---

**请严格遵照以上所有规则，开始生成你的JSON对象：**
`
        }),

        generateEditorIntro: (conciseSummariesText) => ({
            system: '你是一位视野宏大、洞察力敏锐的资深总编辑。内容使用简体中文。',
            user: `根据以下今日核心新闻的一句话摘要，撰写一段200-300字的“总编导语”。\n\n**写作要求:**\n1.  **宏观视角**: 从全局角度，高度概括当日最重要的新闻动态和趋势。\n2.  **深度洞察**: 指出不同新闻事件之间潜在的联系，或它们共同揭示的宏观意义。\n3.  **专业文笔**: 风格沉稳、精炼、富有洞见，符合国家级新闻机构的定位。\n4.  **纯净输出**: 你的回应【只能】包含导语本身，禁止任何额外文字。\n\n---[今日核心新闻摘要]---\n${conciseSummariesText}\n---`
        }),
    }
};

export default CONFIG;